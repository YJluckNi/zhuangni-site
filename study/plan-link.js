/* 学习页 ⇄ 计划拆解 联动（独立脚本，不改学习监督系统的构建产物）
 *
 * 功能：
 *   1. 右下角悬浮「今日待办」面板：列出今天该做的工作包和临时待办，选「这次专注做哪一项」，也能直接勾选完成。
 *   2. 从计划页点「去专注」跳过来时（?task=<计划ID>:<任务ID> 或 ?todo=<待办ID>）自动预选该项。
 *   3. 一次学习结束后，把这次的「专注时长」累加到所选任务（飞书「计划任务 / 今日待办」的 累计专注(分钟)）。
 *   4. 如果用户同意了匿名上传，学习页上传到飞书「学习专注记录」时顺带写上「关联任务」（只加任务标题）。
 *
 * 接入点（基于学习页 v0.2.2 构建产物 assets/index-*.js 读出来的行为，均为外部可观察、无需改它的代码）：
 *   A. 结束钩子：学习结束时，应用把整条会话追加写入 localStorage["study-focus.history.v1"]
 *      （数组，元素含 id / startedAt / endedAt / subject / focusedMs / distractedMs / episodes）。
 *      这里包装 Storage.prototype.setItem，发现新增的会话 id 就按 focusedMs 记到所选任务。
 *      → 只认结束时写入的完整会话，不受中途切标签页影响；同一会话只记一次（zn-plan-link:credited）。
 *   B. 上传钩子：同意上传后，应用会 POST <Worker>/api/study（JSON，含 session_id，与 A 里的 id 相同）。
 *      这里包装 window.fetch，给对应 session_id 的请求体加上 task_title，Worker 写进「关联任务」字段。
 *      没同意上传就不会有这个请求，也就不会写飞书学习记录（专注时长照样记到任务，因为那走计划接口）。
 *   局限：选的是「结束时」面板上选中的那一项；学习页自己的「科目」不受影响。
 *         若学习监督系统改了上面的 localStorage 键名或上传格式，需要同步更新本文件（见《给学习监督系统的计划联动说明.md》）。
 *
 * 重新挂载：学习页更新后，study/gate.js（挂载器）会按顺序加载本文件，见 gate.js 顶部注释。本文件不含任何密钥。
 */
(function () {
  "use strict";
  if (window.__znPlanLink) return;
  window.__znPlanLink = true;

  var HISTORY = "study-focus.history.v1";
  var K_CUR = "zn-plan-link:current";
  var K_MAP = "zn-plan-link:sessions";
  var K_CREDITED = "zn-plan-link:credited";
  var K_OPEN = "zn-plan-link:open";

  var rawSet = Storage.prototype.setItem;
  var rawGet = Storage.prototype.getItem;
  function jget(k, d) { try { var v = rawGet.call(localStorage, k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { rawSet.call(localStorage, k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- 当前选择 ---------- */
  function current() { return jget(K_CUR, null); }
  function setCurrent(sel) {
    if (sel) jset(K_CUR, sel); else { try { localStorage.removeItem(K_CUR); } catch (e) {} }
    render();
  }

  /* ---------- A. 结束钩子 ---------- */
  function idsOf(text) {
    try { var a = JSON.parse(text || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function onHistoryWrite(oldText, newText) {
    var oldIds = {};
    idsOf(oldText).forEach(function (s) { if (s && s.id) oldIds[s.id] = 1; });
    var fresh = idsOf(newText).filter(function (s) { return s && s.id && !oldIds[s.id]; });
    if (!fresh.length) return;
    var sel = current();
    var credited = jget(K_CREDITED, []);
    var map = jget(K_MAP, {});
    fresh.forEach(function (s) {
      if (credited.indexOf(s.id) >= 0) return;
      credited.push(s.id);
      if (!sel) return;
      var min = Math.round(((Number(s.focusedMs) || 0) / 60000) * 10) / 10;
      map[s.id] = { kind: sel.kind, planId: sel.planId || "", id: sel.id, title: sel.title, min: min, at: Date.now() };
      if (min > 0 && window.ZNPlan) {
        window.ZNPlan.addFocus({ kind: sel.kind, planId: sel.planId, id: sel.id }, min);
        flash("已把 " + min + " 分钟专注记到「" + sel.title + "」");
      } else if (min <= 0) {
        flash("这次没有记到专注时长（专注 0 分钟）");
      }
    });
    jset(K_CREDITED, credited.slice(-300));
    var keys = Object.keys(map);
    if (keys.length > 100) keys.sort(function (a, b) { return map[a].at - map[b].at; }).slice(0, keys.length - 100).forEach(function (k) { delete map[k]; });
    jset(K_MAP, map);
    setTimeout(render, 50);
  }
  Storage.prototype.setItem = function (key, value) {
    var watch = this === window.localStorage && key === HISTORY;
    var before = watch ? rawGet.call(this, key) : null;
    var r = rawSet.apply(this, arguments);
    if (watch) { try { onHistoryWrite(before, String(value)); } catch (e) {} }
    return r;
  };

  /* ---------- B. 上传钩子 ---------- */
  if (window.fetch) {
    var rawFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (/\/api\/study\/?$/.test(url) && init && String(init.method || "").toUpperCase() === "POST" && typeof init.body === "string") {
          var body = JSON.parse(init.body);
          var m = jget(K_MAP, {})[body.session_id];
          if (m && m.title && !body.task_title) {
            body.task_title = String(m.title).slice(0, 80);
            init = Object.assign({}, init, { body: JSON.stringify(body) });
          }
        }
      } catch (e) {}
      return rawFetch.call(this, input, init);
    };
  }

  /* ---------- 从计划页跳过来：预选 ---------- */
  var pending = null;
  try {
    var q = new URLSearchParams(location.search);
    var t = q.get("task"), d = q.get("todo");
    if (t && t.indexOf(":") > 0) pending = { kind: "task", planId: t.split(":")[0], id: t.split(":").slice(1).join(":") };
    else if (d) pending = { kind: "todo", id: d };
    if (pending) {
      q.delete("task"); q.delete("todo");
      var rest = q.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    }
  } catch (e) {}

  function resolvePending() {
    if (!pending || !window.ZNPlan) return;
    var title = "";
    if (pending.kind === "todo") {
      var t = window.ZNPlan.listTodos().find(function (x) { return x.id === pending.id; });
      title = t ? t.title : "";
    } else {
      var p = window.ZNPlan.getPlan(pending.planId);
      var n = p && p.nodes.find(function (x) { return x.id === pending.id; });
      title = n ? n.title : "";
    }
    if (title) { setCurrent(Object.assign({}, pending, { title: title, at: Date.now() })); setOpen(true); pending = null; }
  }

  /* ---------- 面板 ---------- */
  var root = null, toastTimer = null;
  function css() {
    var s = document.createElement("style");
    s.id = "zn-plan-link-style";
    s.textContent = [
      "#znpl{position:fixed;right:18px;bottom:18px;z-index:9000;font-family:'Noto Sans CJK SC','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;color:#f3f0e8;-webkit-font-smoothing:antialiased}",
      "html[data-theme='light'] #znpl{color:#1c1914}",
      "#znpl .fab{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px 0 12px;border-radius:999px;border:1px solid rgba(232,200,120,.45);background:rgba(14,14,16,.88);color:inherit;font-size:14px;cursor:pointer;box-shadow:0 12px 30px rgba(0,0,0,.35);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);max-width:min(78vw,420px)}",
      "html[data-theme='light'] #znpl .fab{background:rgba(250,246,239,.94);border-color:rgba(122,86,16,.35);box-shadow:0 12px 30px rgba(40,30,10,.14)}",
      "#znpl .fab .dot{width:9px;height:9px;border-radius:50%;background:#e8c878;box-shadow:0 0 0 4px rgba(232,200,120,.2);flex:none}",
      "#znpl .fab b{font-weight:650;white-space:nowrap}",
      "#znpl .fab .cur{color:#e8c878;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      "html[data-theme='light'] #znpl .fab .cur{color:#7a5610}",
      "#znpl .panel{position:absolute;right:0;bottom:54px;width:min(380px,calc(100vw - 24px));max-height:min(70vh,560px);display:flex;flex-direction:column;border-radius:18px;border:1px solid rgba(243,240,232,.12);background:rgba(14,14,16,.95);box-shadow:0 24px 60px rgba(0,0,0,.45);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overflow:hidden}",
      "html[data-theme='light'] #znpl .panel{background:rgba(250,246,239,.98);border-color:rgba(28,25,20,.1);box-shadow:0 20px 50px rgba(40,30,10,.16)}",
      "#znpl .hd{padding:14px 16px 10px;border-bottom:1px solid rgba(243,240,232,.08)}",
      "html[data-theme='light'] #znpl .hd{border-color:rgba(28,25,20,.08)}",
      "#znpl .hd p{margin:0;font-size:11.5px;letter-spacing:.06em;color:#e8c878}",
      "html[data-theme='light'] #znpl .hd p{color:#7a5610}",
      "#znpl .hd h3{margin:3px 0 0;font-size:16px;font-weight:650}",
      "#znpl .hd .sub{margin-top:4px;font-size:12px;color:#9a958b}",
      "html[data-theme='light'] #znpl .hd .sub{color:#5a554c}",
      "#znpl .bar{height:4px;border-radius:3px;background:rgba(243,240,232,.1);margin-top:10px;overflow:hidden}",
      "#znpl .bar i{display:block;height:100%;background:#e8c878;border-radius:3px}",
      "#znpl .list{overflow:auto;padding:8px}",
      "#znpl .it{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:12px;border:1px solid transparent;cursor:pointer}",
      "#znpl .it:hover{background:rgba(255,255,255,.05)}",
      "html[data-theme='light'] #znpl .it:hover{background:rgba(28,25,20,.04)}",
      "#znpl .it.on{border-color:rgba(232,200,120,.55);background:rgba(232,200,120,.1)}",
      "html[data-theme='light'] #znpl .it.on{border-color:rgba(122,86,16,.4);background:rgba(201,162,74,.12)}",
      "#znpl .it input{margin-top:3px;accent-color:#c9a24a;width:16px;height:16px;flex:none;cursor:pointer}",
      "#znpl .it .t{font-size:13.5px;line-height:1.45;word-break:break-word}",
      "#znpl .it.done .t{text-decoration:line-through;color:#8a8680}",
      "#znpl .it .m{font-size:11px;color:#9a958b;margin-top:2px}",
      "#znpl .it.od .m{color:#f0a39a}",
      "html[data-theme='light'] #znpl .it.od .m{color:#a8392b}",
      "#znpl .it .pick{margin-left:auto;flex:none;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid rgba(232,200,120,.45);color:#e8c878;background:transparent;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center}",
      "html[data-theme='light'] #znpl .it .pick{color:#7a5610;border-color:rgba(122,86,16,.35)}",
      "#znpl .it.on .pick{background:#e8c878;color:#1a1406;border-color:#e8c878}",
      "#znpl .empty{padding:18px 12px;font-size:12.5px;color:#9a958b;line-height:1.7}",
      "#znpl .ft{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-top:1px solid rgba(243,240,232,.08);font-size:12px;color:#9a958b}",
      "html[data-theme='light'] #znpl .ft{border-color:rgba(28,25,20,.08);color:#5a554c}",
      "#znpl .ft a{color:#e8c878;text-decoration:none}",
      "html[data-theme='light'] #znpl .ft a{color:#7a5610}",
      "#znpl .ft button{border:0;background:none;color:inherit;font-size:12px;cursor:pointer;padding:2px 4px}",
      "#znpl .note{margin:8px 8px 0;padding:8px 12px;border-radius:10px;background:rgba(111,207,151,.14);color:#8fdcae;font-size:12.5px}",
      "html[data-theme='light'] #znpl .note{background:rgba(44,122,82,.1);color:#2c6a48}",
      "#znpl .toast{position:absolute;right:0;bottom:54px;max-width:min(360px,calc(100vw - 24px));padding:10px 14px;border-radius:12px;background:#2c5a43;color:#fff;font-size:13px;box-shadow:0 12px 30px rgba(0,0,0,.3)}",
      "@media (max-width:560px){#znpl{right:10px;bottom:10px}#znpl .fab{height:40px;font-size:13px}}"
    ].join("");
    document.head.appendChild(s);
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function isOpen() { return jget(K_OPEN, false) === true; }
  function setOpen(v) { jset(K_OPEN, !!v); render(); }
  function short(d) { return d ? String(d).slice(5).replace("-", "/") : ""; }

  var note = null;
  function flash(msg) {
    note = { msg: msg, until: Date.now() + 6000 };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { note = null; render(); }, 6100);
    render();
  }

  function keepFeishu() {
    var keep = "";
    try { if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) keep = new URLSearchParams(location.search).get("feishu") || ""; } catch (e) {}
    return keep;
  }
  function planHref() {
    var keep = keepFeishu();
    return "../plan/" + (keep ? "?feishu=" + encodeURIComponent(keep) : "");
  }
  function jianzhiHref() {
    var keep = keepFeishu();
    return "../jianzhi/" + (keep ? "?feishu=" + encodeURIComponent(keep) : "");
  }

  function render() {
    if (!root || !window.ZNPlan) return;
    var Z = window.ZNPlan;
    var td = Z.today();
    var sel = current();
    var showNote = note && note.until > Date.now() ? note.msg : "";
    root.innerHTML = "";

    var fab = el("button", "fab");
    fab.type = "button";
    fab.setAttribute("aria-expanded", isOpen() ? "true" : "false");
    fab.appendChild(el("span", "dot"));
    fab.appendChild(el("b", "", "今日待办 " + td.done + "/" + td.total));
    if (sel) fab.appendChild(el("span", "cur", "· 专注：" + sel.title));
    fab.addEventListener("click", function () { setOpen(!isOpen()); });
    root.appendChild(fab);

    if (isOpen()) {
      var panel = el("div", "panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "今日待办");
      var hd = el("div", "hd");
      hd.appendChild(el("p", "", "计划拆解 · 今日待办"));
      hd.appendChild(el("h3", "", sel ? "这次专注：" + sel.title : "这次专注做哪一项？"));
      var f = Z.todayFocus();
      hd.appendChild(el("div", "sub", "已完成 " + td.done + "/" + td.total + " · 今日已专注 " + Math.round(f.minutes) + " 分钟 · 结束学习后时长自动记到所选项"));
      var bar = el("div", "bar"); var bi = el("i"); bi.style.width = (td.total ? Math.round(td.done / td.total * 100) : 0) + "%"; bar.appendChild(bi); hd.appendChild(bar);
      panel.appendChild(hd);
      if (showNote) panel.appendChild(el("div", "note", showNote));

      var list = el("div", "list");
      if (!td.items.length) list.appendChild(el("div", "empty", "今天没有排期中的任务。去计划拆解给工作项排上日期，或添加临时待办。"));
      td.items.forEach(function (it) {
        if (it.kind === "weighin") {
          var rowW = el("div", "it" + (it.done ? " done" : ""));
          var cbW = el("input"); cbW.type = "checkbox"; cbW.checked = it.done; cbW.disabled = true; cbW.title = it.done ? "今日已称重" : "今日尚未称重";
          rowW.appendChild(cbW);
          var midW = el("div"); midW.style.minWidth = "0";
          midW.appendChild(el("div", "t", "今日称重"));
          midW.appendChild(el("div", "m", it.done ? "今天已经记过体重" : "打开减值记录，填一下今天的体重"));
          rowW.appendChild(midW);
          var go = el("a", "pick", it.done ? "查看" : "去称重");
          go.href = jianzhiHref();
          go.addEventListener("click", function (e) { e.stopPropagation(); });
          rowW.appendChild(go);
          rowW.addEventListener("click", function () { location.href = jianzhiHref(); });
          list.appendChild(rowW);
          return;
        }
        var on = sel && sel.kind === it.kind && sel.id === it.id && (it.kind === "todo" || sel.planId === it.planId);
        var row = el("div", "it" + (on ? " on" : "") + (it.done ? " done" : "") + (it.overdue ? " od" : ""));
        var cb = el("input"); cb.type = "checkbox"; cb.checked = it.done; cb.title = "标记完成";
        cb.addEventListener("click", function (e) { e.stopPropagation(); });
        cb.addEventListener("change", function () {
          Z.setDone(it.kind === "todo" ? { kind: "todo", id: it.id } : { kind: "task", planId: it.planId, id: it.id }, cb.checked);
          render();
        });
        row.appendChild(cb);
        var mid = el("div"); mid.style.minWidth = "0";
        mid.appendChild(el("div", "t", it.title));
        var meta = it.kind === "task" ? (it.code + " · " + it.planTitle + (it.overdue ? " · 逾期（" + short(it.endDate) + "）" : "")) : ("临时待办" + (it.overdue ? " · 逾期" : ""));
        if (it.focusMin) meta += " · 已专注 " + Math.round(it.focusMin) + " 分钟";
        mid.appendChild(el("div", "m", meta));
        row.appendChild(mid);
        var pick = el("button", "pick", on ? "已选" : "选这项"); pick.type = "button";
        function choose() {
          if (on) setCurrent(null);
          else setCurrent({ kind: it.kind, planId: it.planId || "", id: it.id, title: it.title, at: Date.now() });
        }
        pick.addEventListener("click", function (e) { e.stopPropagation(); choose(); });
        row.addEventListener("click", choose);
        row.appendChild(pick);
        list.appendChild(row);
      });
      panel.appendChild(list);

      var ft = el("div", "ft");
      var st = Z.state();
      var stText = { synced: "已同步飞书", syncing: "同步中…", offline: "离线（先存本机）", error: "同步失败", local: "仅本机" }[st.status] || "待同步";
      var sbtn = el("button", "", "● " + stText); sbtn.type = "button"; sbtn.title = (st.message || "") + "（点一下立即同步）";
      sbtn.addEventListener("click", function () { Z.sync(); });
      ft.appendChild(sbtn);
      var links = el("span"); links.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end";
      var a = el("a", "", "打开计划拆解 →"); a.href = planHref();
      var jz = el("a", "", "减值记录"); jz.href = jianzhiHref();
      links.appendChild(a); links.appendChild(jz);
      ft.appendChild(links);
      panel.appendChild(ft);
      root.appendChild(panel);
    }
    if (showNote && !isOpen()) root.appendChild(el("div", "toast", showNote));
  }

  function mount() {
    if (root || !document.documentElement.classList.contains("zn-gate-unlocked")) return;
    if (!window.ZNPlan) return;
    css();
    root = el("div");
    root.id = "znpl";
    document.body.appendChild(root);
    resolvePending();
    render();
    window.ZNPlan.sync().then(function () { resolvePending(); render(); });
    window.addEventListener("zn-plan-remote", render);
    window.addEventListener("zn-plan-status", render);
    window.addEventListener("zn-plan-local", function () { setTimeout(render, 0); });
  }
  window.addEventListener("zn-gate-unlocked", mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else setTimeout(mount, 0);
})();
