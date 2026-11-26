/* 壮尼Ni · 计划拆解 / 今日待办 —— 数据层（/plan/ 与 /study/ 共用）
 *
 * - 本地：localStorage 做缓存 + 离线（同一网站下两页共用同一份缓存）
 * - 云端：飞书多维表格（经 Worker 私人接口 /api/plan/*，必须带 Authorization: Bearer <口令>）
 *   口令由公共密码门 assets/gate.js 在解锁时派生并保存；没有口令或连不上中转时自动离线使用。
 * - 冲突：以「最新更新时间」为准。每条计划 / 待办记住上次同步时飞书的时间戳 stamp；
 *   只有本地改了 → 推上去；只有飞书改了 → 拉下来；两边都改了 → 比较本地 updatedAt 与飞书 last_modified_time，新的赢。
 * - 「累计专注(分钟)」以飞书为准：只通过 focus() 累加，保存计划时不会覆盖。
 * - 「今天」按北京时间划分。
 * 依赖：window.WBS（plan/wbs.js）。不含任何密钥。
 */
(function () {
  "use strict";
  if (window.ZNPlan) return;

  var P = "zn-plan:v1:";
  var K_PLAN = P + "plan:";
  var K_TODOS = P + "todos";
  var K_TOMB = P + "deleted";
  var K_FOCUSQ = P + "focusq";
  var K_STATE = P + "state";
  var STUDY_HISTORY = "study-focus.history.v1";
  var TIMEOUT = 20000;

  /* ---------- 工具 ---------- */
  function jget(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowIso() { return new Date().toISOString(); }
  function bjDate(ms) { return new Date((ms == null ? Date.now() : ms) + 8 * 3600000).toISOString().slice(0, 10); }
  function uid(p) { return (p || "x") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function emit(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {} }
  function r1(n) { return Math.round(n * 10) / 10; }

  function endpoint() {
    var ep = window.ZN_FEISHU_ENDPOINT || "";
    return String(ep).replace(/\/+$/, "");
  }
  function token() {
    try {
      if (window.ZNGate && typeof window.ZNGate.token === "function") return window.ZNGate.token() || "";
      return localStorage.getItem("zn-plan-token") || "";
    } catch (e) { return ""; }
  }

  /* ---------- 本地存储 ---------- */
  function planKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(K_PLAN) === 0) out.push(k);
      }
    } catch (e) {}
    return out;
  }
  function rawPlans() { return planKeys().map(function (k) { return jget(k, null); }).filter(function (p) { return p && p.id; }); }
  function rawPlan(id) { return jget(K_PLAN + id, null); }
  function putRaw(p) {
    if (!jset(K_PLAN + p.id, p)) throw new Error("浏览器本地存储已满，请先导出备份再删掉旧计划");
  }
  function strip(p) { var c = clone(p); delete c._sync; return c; }

  /* 内容指纹：记住「上次从飞书读回来的内容」，再拉到时间戳变了但内容一样的记录，
     说明只是自己刚写的（飞书 last_modified_time 有延迟），不当作别人改过，避免误判冲突把本地新改动覆盖掉 */
  function djb2(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ":" + str.length; }
  function planHash(r) {
    var p = WBS.normalizePlan(clone(r));
    var keys = ["title", "goal", "background", "owner", "startDate", "endDate", "notes"];
    var o = {};
    keys.forEach(function (k) { o[k] = p[k] == null ? "" : p[k]; });
    o.nodes = p.nodes.map(function (n) { var c = clone(n); delete c.focusMin; return c; })
      .sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    return djb2(JSON.stringify(o));
  }
  function todoHash(t) {
    return djb2(JSON.stringify([t.title, t.date, !!t.done, t.order || 0, t.doneAt || "", t.notes || ""]));
  }

  function listPlans() {
    return rawPlans().map(strip).sort(function (a, b) { return String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")); });
  }
  function getPlan(id) { var p = rawPlan(id); return p ? strip(p) : null; }

  /** 保存计划（本地立即生效，随后尝试同步飞书） */
  function savePlan(plan, opts) {
    opts = opts || {};
    var old = rawPlan(plan.id);
    var p = WBS.normalizePlan(clone(plan));
    p.id = plan.id || p.id;
    if (!opts.keepTime) p.updatedAt = nowIso();
    // 专注分钟以飞书/本地已记的为准，编辑器里的旧值不覆盖
    if (old) {
      var fm = {};
      (old.nodes || []).forEach(function (n) { fm[n.id] = n.focusMin || 0; });
      p.nodes.forEach(function (n) { if (fm[n.id] != null) n.focusMin = fm[n.id]; });
    }
    p._sync = { dirty: true, stamp: old && old._sync ? old._sync.stamp || 0 : 0 };
    putRaw(p);
    untomb("plan", p.id);
    emit("zn-plan-local", { kind: "plan", id: p.id });
    schedule();
    return strip(p);
  }

  function deletePlan(id) {
    var old = rawPlan(id);
    del(K_PLAN + id);
    if (old && old._sync && old._sync.stamp) tomb("plan", id);
    emit("zn-plan-local", { kind: "plan", id: id, deleted: true });
    schedule();
  }

  /** 导入（JSON 备份 / 单个计划）：较新的覆盖，较旧且内容不同的另存副本，完全相同的跳过 */
  function importPlans(list) {
    var res = { added: 0, replaced: 0, copied: 0, skipped: 0 };
    (list || []).forEach(function (raw) {
      if (!raw || !Array.isArray(raw.nodes)) { res.skipped++; return; }
      var p = WBS.normalizePlan(clone(raw));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(p.id))) p.id = uid("p");
      var old = rawPlan(p.id);
      if (!old) { putRaw(Object.assign(p, { _sync: { dirty: true, stamp: 0 } })); res.added++; return; }
      var same = JSON.stringify(strip(old).nodes) === JSON.stringify(p.nodes) && old.title === p.title && old.goal === p.goal;
      if (same) { res.skipped++; return; }
      if (String(p.updatedAt) > String(old.updatedAt)) {
        p._sync = { dirty: true, stamp: old._sync ? old._sync.stamp || 0 : 0 };
        putRaw(p); res.replaced++;
      } else {
        p.id = uid("p"); p.title = p.title + "（导入副本）"; p.updatedAt = nowIso();
        p._sync = { dirty: true, stamp: 0 };
        putRaw(p); res.copied++;
      }
    });
    emit("zn-plan-local", { kind: "import" });
    schedule();
    return res;
  }

  /* ---------- 待办 ---------- */
  function rawTodos() { return jget(K_TODOS, []); }
  function listTodos() { return rawTodos().map(function (t) { var c = clone(t); delete c._sync; return c; }); }
  function saveTodo(t) {
    var list = rawTodos();
    var i = list.findIndex(function (x) { return x.id === t.id; });
    var old = i >= 0 ? list[i] : null;
    var n = {
      id: t.id || uid("t"),
      title: String(t.title || "").trim().slice(0, 200) || "未命名待办",
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || "") ? t.date : bjDate(),
      done: !!t.done,
      order: Number(t.order) || 0,
      focusMin: old ? old.focusMin || 0 : Number(t.focusMin) || 0,
      doneAt: t.done ? (t.doneAt || (old && old.doneAt) || nowIso()) : "",
      updatedAt: nowIso(),
      _sync: { dirty: true, stamp: old && old._sync ? old._sync.stamp || 0 : 0 }
    };
    if (i >= 0) list[i] = n; else list.push(n);
    jset(K_TODOS, list);
    untomb("todo", n.id);
    emit("zn-plan-local", { kind: "todo", id: n.id });
    schedule();
    return n;
  }
  function deleteTodo(id) {
    var list = rawTodos();
    var old = list.find(function (x) { return x.id === id; });
    jset(K_TODOS, list.filter(function (x) { return x.id !== id; }));
    if (old && old._sync && old._sync.stamp) tomb("todo", id);
    emit("zn-plan-local", { kind: "todo", id: id, deleted: true });
    schedule();
  }

  /* ---------- 删除墓碑 ---------- */
  function tomb(kind, id) {
    var t = jget(K_TOMB, []).filter(function (x) { return !(x.kind === kind && x.id === id); });
    t.push({ kind: kind, id: id, at: nowIso() });
    jset(K_TOMB, t);
  }
  function untomb(kind, id) {
    var t = jget(K_TOMB, []);
    var n = t.filter(function (x) { return !(x.kind === kind && x.id === id); });
    if (n.length !== t.length) jset(K_TOMB, n);
  }
  function isTomb(kind, id) { return jget(K_TOMB, []).some(function (x) { return x.kind === kind && x.id === id; }); }

  /* ---------- 网络 ---------- */
  function req(method, path, body) {
    var ep = endpoint(), tk = token();
    if (!ep) return Promise.reject(Object.assign(new Error("没有配置同步地址"), { local: true }));
    if (!tk) return Promise.reject(Object.assign(new Error("还没有同步口令，请退出后重新输入密码"), { local: true }));
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT);
    var headers = { Authorization: "Bearer " + tk };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(ep + path, {
      method: method, headers: headers, credentials: "omit", cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || d.ok === false) {
          var e = new Error(d.error || ("请求失败（" + res.status + "）"));
          e.status = res.status;
          throw e;
        }
        return d;
      });
    }, function (err) {
      clearTimeout(timer);
      throw Object.assign(new Error("连不上同步中转（可能是网络限制）"), { offline: true, cause: err });
    });
  }

  /* ---------- 同步状态 ---------- */
  var state = Object.assign({ status: "idle", message: "", lastSync: "", todayFocusMin: null, todayFocusDate: "" }, jget(K_STATE, {}));
  function setState(patch) {
    Object.assign(state, patch);
    jset(K_STATE, { lastSync: state.lastSync, todayFocusMin: state.todayFocusMin, todayFocusDate: state.todayFocusDate });
    emit("zn-plan-status", Object.assign({}, state));
  }

  /* ---------- 计划推送 ---------- */
  function preparePush(p) {
    var c = WBS.compute(clone(strip(p)));
    var byId = {};
    c.nodes.forEach(function (n) { byId[n.id] = n; });
    var out = strip(p);
    out.nodes = out.nodes.map(function (n) {
      var x = byId[n.id] || {};
      return Object.assign({}, n, { code: x.code || "", level: x.level || 1 });
    });
    out.stats = { progress: c.stats.progress, total: c.stats.total };
    return out;
  }

  function applyRemoteFocus(local, remote) {
    var fm = {};
    (remote.nodes || []).forEach(function (n) { fm[n.id] = n.focusMin || 0; });
    (local.nodes || []).forEach(function (n) { if (fm[n.id] != null) n.focusMin = fm[n.id]; });
  }

  function pushPlan(id) {
    var p = rawPlan(id);
    if (!p) return Promise.resolve();
    var sentAt = p.updatedAt;
    return req("PUT", "/api/plan/plans/" + encodeURIComponent(id), preparePush(p)).then(function (d) {
      var cur = rawPlan(id);
      if (!cur) return;
      if (d.plan) {
        cur._sync = cur._sync || {};
        cur._sync.stamp = d.plan.remoteStamp || cur._sync.stamp || 0;
        cur._sync.rh = planHash(d.plan);
        applyRemoteFocus(cur, d.plan);
      }
      if (cur.updatedAt === sentAt) cur._sync.dirty = false;
      putRaw(cur);
    });
  }

  function pushTodo(id) {
    var t = rawTodos().find(function (x) { return x.id === id; });
    if (!t) return Promise.resolve();
    var sentAt = t.updatedAt;
    var body = clone(t); delete body._sync;
    return req("PUT", "/api/plan/todos/" + encodeURIComponent(id), body).then(function (d) {
      var list = rawTodos();
      var cur = list.find(function (x) { return x.id === id; });
      if (!cur) return;
      cur._sync = cur._sync || {};
      if (d.todo) { cur._sync.stamp = d.todo.remoteStamp || cur._sync.stamp || 0; cur._sync.rh = todoHash(d.todo); cur.focusMin = d.todo.focusMin || cur.focusMin || 0; }
      if (cur.updatedAt === sentAt) cur._sync.dirty = false;
      jset(K_TODOS, list);
    });
  }

  /* ---------- 合并 ---------- */
  function mergePlans(remotes) {
    var changed = [];
    var seen = {};
    remotes.forEach(function (r) {
      seen[r.id] = 1;
      if (isTomb("plan", r.id)) return;
      var L = rawPlan(r.id);
      var stamp = r.remoteStamp || 0;
      var remotePlan = WBS.normalizePlan(clone(r));
      remotePlan.id = r.id;
      var rh = planHash(r);
      if (!L) {
        remotePlan._sync = { dirty: false, stamp: stamp, rh: rh };
        putRaw(remotePlan); changed.push(r.id); return;
      }
      var sync = L._sync || { dirty: true, stamp: 0 };
      var remoteChanged = stamp > (sync.stamp || 0) && !(sync.rh && sync.rh === rh);
      var takeRemote = false;
      if (remoteChanged && !sync.dirty) takeRemote = true;
      else if (remoteChanged && sync.dirty) takeRemote = Date.parse(L.updatedAt || 0) < stamp;
      if (takeRemote) {
        remotePlan._sync = { dirty: false, stamp: stamp, rh: rh };
        if (!remotePlan.updatedAt || Date.parse(remotePlan.updatedAt) < stamp) remotePlan.updatedAt = new Date(stamp).toISOString();
        putRaw(remotePlan); changed.push(r.id);
      } else {
        var before = JSON.stringify(L.nodes.map(function (n) { return n.focusMin; }));
        applyRemoteFocus(L, r);
        if (!remoteChanged) { L._sync = L._sync || sync; L._sync.stamp = Math.max(sync.stamp || 0, stamp); }
        putRaw(L);
        if (before !== JSON.stringify(L.nodes.map(function (n) { return n.focusMin; }))) changed.push(r.id);
      }
    });
    // 飞书里已删除：本地同步过且没改过 → 跟着删
    rawPlans().forEach(function (L) {
      if (seen[L.id]) return;
      if (L._sync && L._sync.stamp && !L._sync.dirty) { del(K_PLAN + L.id); changed.push(L.id); }
    });
    return changed;
  }

  function mergeTodos(remotes) {
    var list = rawTodos();
    var byId = {};
    list.forEach(function (t) { byId[t.id] = t; });
    var seen = {};
    var changed = false;
    remotes.forEach(function (r) {
      seen[r.id] = 1;
      if (isTomb("todo", r.id)) return;
      var L = byId[r.id];
      var stamp = r.remoteStamp || 0;
      var R = Object.assign({}, r); delete R.remoteStamp;
      var rh = todoHash(R);
      if (!L) { R._sync = { dirty: false, stamp: stamp, rh: rh }; list.push(R); byId[r.id] = R; changed = true; return; }
      var sync = L._sync || { dirty: true, stamp: 0 };
      var remoteChanged = stamp > (sync.stamp || 0) && !(sync.rh && sync.rh === rh);
      if (!remoteChanged && stamp > (sync.stamp || 0)) { L._sync = sync; L._sync.stamp = stamp; }
      var take = (remoteChanged && !sync.dirty) || (remoteChanged && sync.dirty && Date.parse(L.updatedAt || 0) < stamp);
      if (take) { R._sync = { dirty: false, stamp: stamp, rh: rh }; Object.keys(L).forEach(function (k) { delete L[k]; }); Object.assign(L, R); changed = true; }
      else { if (L.focusMin !== r.focusMin) { L.focusMin = r.focusMin; changed = true; } }
    });
    list = list.filter(function (t) {
      if (seen[t.id]) return true;
      if (t._sync && t._sync.stamp && !t._sync.dirty) { changed = true; return false; }
      return true;
    });
    jset(K_TODOS, list);
    return changed;
  }

  /* ---------- 同步主流程（串行） ---------- */
  var running = null, again = false, timer = null;
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { sync(); }, ms == null ? 900 : ms);
  }

  function flushFocusQueue() {
    var q = jget(K_FOCUSQ, []);
    if (!q.length) return Promise.resolve();
    var item = q[0];
    return req("POST", "/api/plan/focus", item).then(function () {
      jset(K_FOCUSQ, jget(K_FOCUSQ, []).slice(1));
      return flushFocusQueue();
    }, function (e) {
      if (e.status === 404 || e.status === 400) { jset(K_FOCUSQ, jget(K_FOCUSQ, []).slice(1)); return flushFocusQueue(); }
      throw e;
    });
  }

  function sync() {
    if (running) { again = true; return running; }
    if (!endpoint() || !token()) {
      setState({ status: "local", message: !endpoint() ? "未配置同步地址，仅保存在本机" : "未拿到同步口令，仅保存在本机（退出后重新输入密码即可）" });
      return Promise.resolve(state);
    }
    if (navigator.onLine === false) { setState({ status: "offline", message: "设备离线，修改先存在本机" }); return Promise.resolve(state); }
    setState({ status: "syncing", message: "正在与飞书同步…" });
    running = (async function () {
      // 1) 删除
      for (var t of jget(K_TOMB, [])) {
        await req("DELETE", "/api/plan/" + (t.kind === "todo" ? "todos/" : "plans/") + encodeURIComponent(t.id));
        untomb(t.kind, t.id);
      }
      // 2) 先推专注（推完再拉，拉回来的就是最新累计值）
      await flushFocusQueue();
      // 3) 拉
      var d = await req("GET", "/api/plan/sync");
      var changed = mergePlans(d.plans || []);
      var todoChanged = mergeTodos(d.todos || []);
      // 4) 推本地改动
      var dirtyPlans = rawPlans().filter(function (p) { return !p._sync || p._sync.dirty; });
      for (var p of dirtyPlans) await pushPlan(p.id);
      var dirtyTodos = rawTodos().filter(function (x) { return !x._sync || x._sync.dirty; });
      for (var x of dirtyTodos) await pushTodo(x.id);
      setState({
        status: "synced", message: "已与飞书同步", lastSync: nowIso(),
        todayFocusMin: typeof d.todayFocusMin === "number" ? d.todayFocusMin : state.todayFocusMin,
        todayFocusDate: d.today || bjDate()
      });
      if (changed.length || todoChanged) emit("zn-plan-remote", { plans: changed, todos: todoChanged });
      return state;
    })().catch(function (e) {
      if (e.local) setState({ status: "local", message: e.message });
      else if (e.offline) setState({ status: "offline", message: "连不上同步中转，修改先存在本机，恢复后自动同步" });
      else setState({ status: "error", message: "同步失败：" + e.message, code: e.status || 0 });
      return state;
    }).then(function (r) {
      running = null;
      // 同步期间又有新改动：紧接着再跑一轮，调用方拿到的 Promise 在这一轮结束后才完成
      if (again) { again = false; return sync(); }
      return r;
    });
    return running;
  }

  /* ---------- 专注 ---------- */
  /** ref: { kind:"task", planId, id } | { kind:"todo", id } */
  function addFocus(ref, minutes) {
    minutes = r1(Number(minutes) || 0);
    if (!(minutes > 0)) return Promise.resolve(null);
    if (ref.kind === "todo") {
      var list = rawTodos();
      var t = list.find(function (x) { return x.id === ref.id; });
      if (t) { t.focusMin = r1((t.focusMin || 0) + minutes); jset(K_TODOS, list); }
    } else {
      var p = rawPlan(ref.planId);
      var n = p && p.nodes.find(function (x) { return x.id === ref.id; });
      if (n) { n.focusMin = r1((n.focusMin || 0) + minutes); putRaw(p); }
    }
    var q = jget(K_FOCUSQ, []);
    q.push({ kind: ref.kind === "todo" ? "todo" : "task", planId: ref.planId || "", id: ref.id, minutes: Math.min(720, minutes) });
    jset(K_FOCUSQ, q);
    emit("zn-plan-local", { kind: "focus" });
    schedule(200);
    return Promise.resolve(minutes);
  }

  /** 今日已专注（分钟）：本机学习记录（北京时间今天）与飞书学习记录合计取较大值 */
  function todayFocus() {
    var today = bjDate();
    var local = 0;
    var hist = jget(STUDY_HISTORY, []);
    if (Array.isArray(hist)) hist.forEach(function (s) {
      if (s && typeof s.startedAt === "number" && bjDate(s.startedAt) === today) local += (Number(s.focusedMs) || 0) / 60000;
    });
    var remote = state.todayFocusDate === today && typeof state.todayFocusMin === "number" ? state.todayFocusMin : 0;
    return { minutes: r1(Math.max(local, remote)), local: r1(local), remote: r1(remote) };
  }

  /* ---------- 今日待办 ---------- */
  function today() {
    var day = bjDate();
    var items = [];
    rawPlans().forEach(function (p) {
      var c = WBS.compute(clone(strip(p)));
      c.nodes.forEach(function (n) {
        if (!n.isLeaf) return;
        var done = n.status === "done" || n.progress >= 100;
        var inRange = n.startDate && n.endDate && n.startDate <= day && day <= n.endDate;
        var overdue = !done && n.endDate && n.endDate < day;
        var doneToday = done && n.doneDate === day;
        if (!((inRange && !done) || overdue || doneToday)) return;
        items.push({
          key: "task:" + p.id + ":" + n.id, kind: "task", planId: p.id, planTitle: p.title, id: n.id,
          code: n.code, title: n.title, startDate: n.startDate, endDate: n.endDate,
          done: done, overdue: !!overdue, focusMin: n.focusMin || 0, order: n.todayOrder || 0,
          progress: n.progress, status: n.status, deliverable: n.deliverable
        });
      });
    });
    rawTodos().forEach(function (t) {
      var doneToday = t.done && t.doneAt && bjDate(Date.parse(t.doneAt)) === day;
      var isToday = t.date === day;
      var overdue = !t.done && t.date < day;
      if (!(isToday || overdue || doneToday)) return;
      items.push({
        key: "todo:" + t.id, kind: "todo", id: t.id, title: t.title, date: t.date,
        done: !!t.done, overdue: !!overdue, focusMin: t.focusMin || 0, order: t.order || 0
      });
    });
    items.sort(function (a, b) {
      var ao = a.order || 1e6, bo = b.order || 1e6;
      if (ao !== bo) return ao - bo;
      return String(a.endDate || a.date || "").localeCompare(String(b.endDate || b.date || ""));
    });
    var done = items.filter(function (i) { return i.done; }).length;
    return { date: day, items: items, total: items.length, done: done, overdue: items.filter(function (i) { return i.overdue; }).length };
  }

  /** 勾选 / 取消完成（计划任务回写进度和状态，待办回写已完成） */
  function setDone(ref, done) {
    if (ref.kind === "todo") {
      var t = rawTodos().find(function (x) { return x.id === ref.id; });
      if (t) saveTodo(Object.assign({}, t, { done: !!done, doneAt: done ? nowIso() : "" }));
      return;
    }
    var p = getPlan(ref.planId);
    if (!p) return;
    var n = p.nodes.find(function (x) { return x.id === ref.id; });
    if (!n) return;
    if (done) {
      n.prevProgress = n.progress < 100 ? n.progress : 0;
      n.status = "done"; n.progress = 100; n.doneDate = bjDate();
    } else {
      var back = Number(n.prevProgress) || 0;
      n.progress = back; n.status = back > 0 ? "in_progress" : "not_started"; n.doneDate = "";
    }
    // prevProgress 只在本机用，normalizeNode 不保留时放在 notes 之外的本地字段
    var prev = n.prevProgress;
    var saved = savePlan(p);
    if (done && prev != null) {
      var raw = rawPlan(saved.id);
      var rn = raw && raw.nodes.find(function (x) { return x.id === ref.id; });
      if (rn) { rn.prevProgress = prev; putRaw(raw); }
    }
  }

  /** 按给定顺序（item.key 数组）重排今日待办 */
  function reorder(keys) {
    var touchedPlans = {};
    var todos = rawTodos();
    var todoChanged = false;
    keys.forEach(function (key, i) {
      var order = i + 1;
      var parts = key.split(":");
      if (parts[0] === "todo") {
        var t = todos.find(function (x) { return x.id === parts[1]; });
        if (t && t.order !== order) { t.order = order; t.updatedAt = nowIso(); t._sync = Object.assign({}, t._sync, { dirty: true }); todoChanged = true; }
      } else {
        var pid = parts[1], nid = parts[2];
        var p = touchedPlans[pid] || getPlan(pid);
        if (!p) return;
        var n = p.nodes.find(function (x) { return x.id === nid; });
        if (n && n.todayOrder !== order) { n.todayOrder = order; touchedPlans[pid] = p; }
      }
    });
    if (todoChanged) jset(K_TODOS, todos);
    Object.keys(touchedPlans).forEach(function (pid) { savePlan(touchedPlans[pid]); });
    emit("zn-plan-local", { kind: "reorder" });
    schedule();
  }

  /* ---------- 自动同步时机 ---------- */
  window.addEventListener("online", function () { schedule(200); });
  window.addEventListener("offline", function () { setState({ status: "offline", message: "设备离线，修改先存在本机" }); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") schedule(300); });
  setInterval(function () { if (document.visibilityState === "visible") sync(); }, 90000);
  // 别的标签页（比如学习页）改了本地缓存 → 通知本页刷新
  window.addEventListener("storage", function (e) {
    if (e.key && (e.key.indexOf(P) === 0 || e.key === STUDY_HISTORY)) emit("zn-plan-remote", { storage: true });
  });

  window.ZNPlan = {
    bjDate: bjDate, uid: uid,
    listPlans: listPlans, getPlan: getPlan, savePlan: savePlan, deletePlan: deletePlan, importPlans: importPlans,
    listTodos: listTodos, saveTodo: saveTodo, deleteTodo: deleteTodo,
    today: today, setDone: setDone, reorder: reorder,
    addFocus: addFocus, todayFocus: todayFocus,
    sync: sync, schedule: schedule, state: function () { return Object.assign({}, state); },
    request: req, endpoint: endpoint, hasToken: function () { return !!token(); }
  };
})();
