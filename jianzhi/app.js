/* 减值记录 — 网站版前端（数据走 Worker / 飞书，照片只留本机） */
(function () {
  "use strict";
  var E = window.Engine;
  var CACHE_KEY = "zn-jianzhi:v1:cache";
  var PENDING_KEY = "zn-jianzhi:v1:pending";
  var WEIGH_KEY = "zn-plan:v1:weighin";
  var S = { profile: {}, daily: [], measurements: [], today: "", offline: false };
  var WK = { type: "", min: null, kcal: null };
  var WK_LIST = [];
  var REC_EDIT = { date: null, isNew: false };
  var PHOTOS = [];
  var CMP = { a: null, b: null };
  var AI_RESULT = null;
  var SYNC = { status: "idle", message: "", last: "" };

  function $(id) { return document.getElementById(id); }
  function jget(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function toast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("on"); }, 2200);
  }
  function endpoint() { return String(window.ZN_FEISHU_ENDPOINT || "").replace(/\/+$/, ""); }
  function token() {
    try {
      if (window.ZNGate && typeof window.ZNGate.token === "function") return window.ZNGate.token() || "";
      return localStorage.getItem("zn-plan-token") || "";
    } catch (e) { return ""; }
  }
  function todayBJ() { return E.todayISO(); }
  function fmtDateCN(iso) {
    if (!iso) return "";
    var p = String(iso).split("-");
    if (p.length < 3) return "";
    return p[0] + " 年 " + Number(p[1]) + " 月 " + Number(p[2]) + " 日";
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return "—";
    return (Math.round(n * 100) / 100).toFixed(d == null ? 1 : d);
  }
  function signed(n, d) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n * 100) / 100;
    return ((v > 0 ? "+" : "") + v.toFixed(d == null ? 1 : d)).replace("-", "−");
  }

  function api(method, path, body) {
    var ep = endpoint(), tk = token();
    if (!ep) return Promise.reject(Object.assign(new Error("没有配置同步地址"), { local: true }));
    if (!tk) return Promise.reject(Object.assign(new Error("还没有同步口令，请退出后重新输入密码"), { local: true }));
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
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
      throw Object.assign(new Error("连不上同步中转"), { offline: true, cause: err });
    });
  }

  function setSync(st, msg) {
    SYNC.status = st;
    if (msg) SYNC.message = msg;
    if (st === "synced") SYNC.last = new Date().toISOString();
    var pill = $("syncPill");
    if (!pill) return;
    var map = { synced: "已同步", syncing: "同步中…", offline: "离线", error: "同步失败", local: "仅本机", idle: "未同步" };
    pill.dataset.state = st;
    var label = map[st] || st;
    if (st === "synced" && SYNC.last) {
      var d = new Date(new Date(SYNC.last).getTime() + 8 * 3600000);
      var hh = String(d.getUTCHours()).padStart(2, "0");
      var mm = String(d.getUTCMinutes()).padStart(2, "0");
      label = "已同步 " + hh + ":" + mm;
    }
    var span = pill.querySelector("span");
    if (span) span.textContent = label;
  }

  function cacheState() {
    jset(CACHE_KEY, { profile: S.profile, daily: S.daily, measurements: S.measurements, today: S.today, at: Date.now() });
  }
  function applyCache() {
    var c = jget(CACHE_KEY, null);
    if (!c) return false;
    S.profile = c.profile || {};
    S.daily = c.daily || [];
    S.measurements = c.measurements || [];
    S.today = c.today || todayBJ();
    return true;
  }
  function queue(op) {
    var list = jget(PENDING_KEY, []);
    list.push(op);
    jset(PENDING_KEY, list);
  }
  function publishWeighIn() {
    var rec = todayRecord();
    var w = { date: S.today, done: !!(rec && rec.weight), weight: rec && rec.weight ? rec.weight : null };
    jset(WEIGH_KEY, w);
    try { window.dispatchEvent(new CustomEvent("zn-plan-local", { detail: { kind: "weighin" } })); } catch (e) {}
  }

  function upsertLocalDaily(rec) {
    var list = S.daily.slice();
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].date === rec.date) i = k;
    if (i >= 0) list[i] = Object.assign({}, list[i], rec);
    else list.push(rec);
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    S.daily = list;
    cacheState();
    publishWeighIn();
  }
  function removeLocalDaily(date) {
    S.daily = S.daily.filter(function (d) { return d.date !== date; });
    cacheState();
    publishWeighIn();
  }

  async function flushPending() {
    var list = jget(PENDING_KEY, []);
    if (!list.length) return;
    var remain = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      try {
        if (op.op === "putDaily") await api("PUT", "/api/jianzhi/daily/" + op.date, op.body);
        else if (op.op === "delDaily") await api("DELETE", "/api/jianzhi/daily/" + op.date);
        else if (op.op === "putProfile") await api("PUT", "/api/jianzhi/profile", op.body);
        else if (op.op === "putMeasure") await api("PUT", "/api/jianzhi/measurement/" + op.date, op.body);
        else if (op.op === "delMeasure") await api("DELETE", "/api/jianzhi/measurement/" + op.date);
      } catch (e) {
        remain = remain.concat(list.slice(i));
        break;
      }
    }
    jset(PENDING_KEY, remain);
    if (list.length && remain.length < list.length) toast("已补记之前暂存的记录");
    return remain.length === 0;
  }

  function todayRecord() {
    for (var i = 0; i < S.daily.length; i++) if (S.daily[i].date === S.today) return S.daily[i];
    return null;
  }
  function findRec(date) {
    for (var i = 0; i < S.daily.length; i++) if (S.daily[i].date === date) return S.daily[i];
    return null;
  }
  function lastRecordBefore(date) {
    var list = S.daily.filter(function (x) { return x.date < date && x.weight != null; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return list.length ? list[list.length - 1] : null;
  }

  async function load(fromUser) {
    setSync("syncing");
    try {
      await flushPending();
      var d = await api("GET", "/api/jianzhi/sync");
      S.profile = d.profile || {};
      S.daily = d.daily || [];
      S.measurements = d.measurements || [];
      S.today = d.today || todayBJ();
      S.offline = false;
      cacheState();
      if (d.weighIn) jset(WEIGH_KEY, d.weighIn);
      setSync("synced");
      renderAll();
      afterLoad();
    } catch (e) {
      S.today = S.today || todayBJ();
      var had = applyCache();
      S.offline = !!(e && (e.offline || e.local));
      setSync(S.offline ? (had ? "offline" : "local") : "error", e && e.message);
      renderAll();
      afterLoad();
      if (fromUser) toast(e && e.message ? e.message : "同步失败");
      else if (!had) toast("还没有本地缓存，连上同步后再试");
    }
  }

  function afterLoad() {
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    if (st && st.recorded7 >= 3) {
      AI_RESULT = E.localAnalysis({ stats: st, profile: S.profile, cheatStats: E.cheatStats(S.daily, series) });
      renderAI();
      runAI(false);
    }
    if (!S.profile.targetWeight && S.daily.length === 0) openSettings();
    focusWeight();
    loadPhotos().then(function () { renderPhotos(); renderCompare(); });
  }

  function focusWeight() {
    var input = $("weightInput");
    if (!input) return;
    setTimeout(function () {
      try { input.focus(); if (!input.value) input.select(); } catch (e) {}
    }, 200);
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    renderHeader();
    renderTodayCard();
    renderPrediction();
    renderChart();
    renderCalories();
    renderAI();
    renderAchievements();
    renderWaist();
    renderRecent();
    renderPhotos();
    renderCompare();
  }

  function renderHeader() {
    var d = E.parseISO(S.today);
    $("todayLabel").textContent = (d.getMonth() + 1) + " 月 " + d.getDate() + " 日";
    $("weekdayLabel").textContent = E.formatWeekday(S.today) + " · 北京时间";
  }

  function renderTodayCard() {
    var rec = todayRecord();
    var tag = $("todayTag");
    var input = $("weightInput");
    if (rec && rec.weight != null) {
      tag.textContent = "已记录";
      tag.className = "tag ok";
      input.value = rec.weight;
      $("sleepInput").value = rec.sleep == null ? "" : rec.sleep;
      $("stepsInput").value = rec.steps == null ? "" : rec.steps;
      $("cheatInput").checked = !!rec.cheat;
      $("dietInput").value = rec.diet || "";
      $("btnSave").textContent = "更 新";
    } else {
      tag.textContent = "待记录";
      tag.className = "tag";
      $("btnSave").textContent = "保 存";
      $("sleepInput").value = rec && rec.sleep != null ? rec.sleep : "";
      $("stepsInput").value = rec && rec.steps != null ? rec.steps : "";
      $("cheatInput").checked = !!(rec && rec.cheat);
      $("dietInput").value = rec && rec.diet ? rec.diet : $("dietInput").value;
      var last = lastRecordBefore(S.today);
      if (!input.value && last) input.value = last.weight;
    }
    WK_LIST = E.workoutsOf(rec);
    syncWorkoutLabel();
    renderMeals(rec);
    syncCheatStyle();
    renderFeedback(rec);
    renderBmi(rec);
  }

  function renderBmi(rec) {
    var row = $("bmiRow");
    var w = rec && rec.weight != null ? rec.weight : (lastRecordBefore(S.today) || {}).weight;
    var meas = lastMeasure();
    var comp = E.bodyComposition(w, S.profile || {}, meas && meas.waist, meas && meas.hip);
    if (!comp) { row.hidden = true; row.innerHTML = ""; return; }
    row.hidden = false;
    var parts = ["BMI <b>" + comp.bmi + "</b>", "体脂约 <b>" + comp.bf + "%</b>"];
    if (comp.whtr != null) parts.push("腰围身高比 <b>" + comp.whtr + "</b>");
    row.innerHTML = parts.join(" · ");
  }

  function lastMeasure() {
    var list = (S.measurements || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return list.length ? list[list.length - 1] : null;
  }

  function renderFeedback(rec) {
    var box = $("feedback");
    if (!rec || rec.weight == null) { box.classList.remove("on"); box.innerHTML = ""; return; }
    var prev = lastRecordBefore(rec.date);
    var delta = (prev && rec.weight != null) ? rec.weight - prev.weight : null;
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    var html = "";
    if (delta != null) {
      var cls = delta < 0 ? "down" : (delta > 0 ? "up" : "");
      html += '<div class="fb-line">较上次（' + prev.date.slice(5) + '）<b class="' + cls + '">' + signed(delta) + " 公斤</b></div>";
    }
    if (st && st.r != null) {
      var rcls = st.r < 0 ? "down" : (st.r > 0 ? "up" : "");
      html += '<div class="fb-line">7 日趋势 <b class="' + rcls + '">' + signed(st.r) + " 公斤/周</b>" +
        (st.r < 0 ? "，一周约减 " + fmt(-st.r) + " 公斤" : "") + "</div>";
    }
    if (st) {
      html += '<div class="fb-line">近 28 天记录 ' + st.recorded28 + " 天" +
        (st.coverage ? " · 覆盖率 " + Math.round(st.coverage * 100) + "%" : "") + "</div>";
    }
    box.innerHTML = html;
    box.classList.add("on");
  }

  function renderMeals(rec) {
    var box = $("mealList");
    var meals = E.mealsOf(rec);
    if (!meals.length) { box.innerHTML = ""; return; }
    box.innerHTML = meals.map(function (m) {
      return '<div class="meal-chip"><span class="slot">' + E.mealLabel(m.slot) + "</span><span>" +
        (m.text || "") + '</span><span class="kcal">' + (m.kcal != null ? m.kcal : "—") +
        '</span><button type="button" data-slot="' + m.slot + '" aria-label="删除这餐">×</button></div>';
    }).join("");
  }

  function syncCheatStyle() {
    $("cheatOpt").classList.toggle("active", $("cheatInput").checked);
  }
  function syncWorkoutLabel() {
    $("workoutLabel").textContent = WK_LIST.length ? E.workoutText({ workouts: WK_LIST }) : "未记录";
  }

  function renderPrediction() {
    var body = $("predictBody");
    var tag = $("predictTag");
    var banner = $("paceBanner");
    var target = Number(S.profile.targetWeight) || 0;
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);

    var paceW = (st && st.ema) || (todayRecord() && todayRecord().weight) || S.profile.startWeight;
    var pace = E.planPace(paceW, target, S.profile.targetDate, S.today);
    if (pace && pace.unsafe) {
      banner.hidden = false;
      banner.innerHTML = "按现在的目标日期，需要每周减 <b>" + fmt(pace.needPerWeek) +
        "</b> 公斤，已超过安全上限（每周最多 <b>" + fmt(pace.cap) + "</b> 公斤）。" +
        (pace.suggestedDate ? "建议把目标日期延到 <b>" + fmtDateCN(pace.suggestedDate) + "</b>，或先按安全速度推进。" : "");
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }

    if (!target) {
      tag.textContent = "未设置目标";
      body.innerHTML = '<div class="predict-main"><div class="predict-date small">先设置目标体重</div><div class="predict-sub">点右上角设置，填上目标体重，就能算出预计达成日期。</div></div>';
      return;
    }
    var p = E.predict(series, target, { targetDate: S.profile.targetDate });
    if (!p.ok) {
      tag.textContent = "数据不足";
      body.innerHTML = '<div class="predict-main"><div class="predict-date small">先记录今天的体重</div><div class="predict-sub">连续记录 7 天后，预测会更有把握。</div></div>';
      return;
    }
    if (p.reached) {
      tag.textContent = "已达成";
      body.innerHTML = '<div class="predict-main"><div class="predict-date">已到达 ' + fmt(target) + ' kg</div><div class="predict-sub">当前 7 日趋势 <b>' + fmt(p.ema) + " kg</b>。可以重新设定下一个目标。</div></div>";
      return;
    }
    var confMap = { high: "高可信", mid: "中等可信", low: "初步估计", none: "数据不足" };
    tag.textContent = "目标 " + fmt(target) + " kg";
    if (p.confidence.level === "none") {
      var need = Math.max(1, 7 - ((st && st.recorded7) || 0));
      body.innerHTML = '<div class="predict-main"><div class="predict-date small">已记录，等待趋势成形</div><div class="predict-sub">再记 <b>' + need + "</b> 天就能算出达成日期。<br>宁可晚几天，也不给不准的日期。</div></div>";
      return;
    }
    if (p.stalled) {
      body.innerHTML = '<div class="notice">近一周几乎没有变化（' + signed(p.r || 0, 2) + " 公斤/周），按现在的节奏到不了目标。</div>" +
        '<div class="predict-main"><div class="predict-label">当前 7 日趋势</div><div class="predict-date small">' + fmt(p.ema) + " kg</div><div class=\"predict-sub\">" + (p.note || "") + "。</div></div>";
      return;
    }
    var days = Math.round(p.weeks * 7);
    var cmp = "";
    if (p.planDaysLeft != null && p.planDaysLeft > 0) {
      var gap = days - p.planDaysLeft;
      if (gap > 3) cmp = "比目标日期<b>晚 " + gap + " 天</b>";
      else if (gap < -3) cmp = "比目标日期<b>早 " + (-gap) + " 天</b>";
      else cmp = "与目标日期基本吻合";
    }
    var html = '<div class="predict-main"><div class="predict-label">预计到达 ' + fmt(target) + ' kg</div>' +
      '<div class="predict-date">' + E.formatDate(p.reachDate) + "</div>" +
      '<div class="predict-sub">约 <b>' + days + " 天</b>后" + (cmp ? " · " + cmp : "") + "</div>" +
      '<div class="conf">' + (confMap[p.confidence.level] || "") + " · 覆盖率 " + Math.round(((st && st.coverage) || 0) * 100) + "%</div></div>";
    if (p.scenarios && p.scenarios.length) html += renderScenarioChart(p);
    body.innerHTML = html;
  }

  function renderScenarioChart(p) {
    var W = 320, rows = p.scenarios.length, H = 14 + rows * 30;
    var left = 60, barMax = W - left - 62, barH = 15, maxW = 0;
    p.scenarios.forEach(function (s) { if (s.weeks != null && s.weeks > maxW) maxW = s.weeks; });
    var color = { base: "var(--jz-accent)", boost: "#2F6D5B", relax: "#C9773A" };
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img">'];
    p.scenarios.forEach(function (s, i) {
      var y = 6 + i * 30;
      out.push('<text x="0" y="' + (y + 11) + '" class="sv-lbl">' + s.label + "</text>");
      out.push('<rect x="' + left + '" y="' + y + '" width="' + barMax + '" height="' + barH + '" rx="3" fill="var(--jz-chart-track)"></rect>');
      if (s.weeks == null) {
        out.push('<text x="' + (left + 8) + '" y="' + (y + 11) + '" class="sv-axis">到不了目标</text>');
      } else {
        var w = Math.max(10, Math.round(s.weeks / maxW * barMax));
        out.push('<rect x="' + left + '" y="' + y + '" width="' + w + '" height="' + barH + '" rx="3" fill="' + (color[s.key] || "#8A93A0") + '"></rect>');
        out.push('<text x="' + W + '" y="' + (y + 11) + '" text-anchor="end" class="sv-strong">' + E.formatDate(s.date).replace(/^\d+ 年 /, "") + "</text>");
      }
    });
    out.push("</svg>");
    return out.join("");
  }

  function renderChart() {
    var box = $("chartBox");
    var series = E.buildSeries(S.daily, S.today);
    var recorded = series.filter(function (s) { return s.weight != null; });
    if (recorded.length < 2) {
      box.innerHTML = '<div class="week-note" style="padding:16px 0;text-align:center">记录两天以上，这里会出现你的趋势线。</div>';
      $("trendTag").textContent = "暂无数据";
      return;
    }
    $("trendTag").textContent = recorded.length + " 天记录";
    var W = 420, H = 220, padL = 38, padR = 10, padT = 14, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var target = Number(S.profile.targetWeight) || 0;
    var vals = series.map(function (s) { return s.ema; }).concat(series.map(function (s) { return s.weight; })).filter(function (v) { return v != null; });
    if (target) vals.push(target);
    var min = Math.min.apply(null, vals) - 0.6, max = Math.max.apply(null, vals) + 0.6;
    function xOf(i) { return padL + plotW * i / Math.max(1, series.length - 1); }
    function yOf(v) { return padT + plotH * (max - v) / (max - min || 1); }
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" role="img">'];
    for (var g = 0; g < 4; g++) {
      var gy = padT + plotH * g / 3;
      out.push('<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="var(--jz-line)" stroke-width="1"/>');
      out.push('<text x="0" y="' + (gy + 3) + '" class="sv-axis">' + (max - (max - min) * g / 3).toFixed(1) + "</text>");
    }
    if (target) {
      var ty = yOf(target);
      out.push('<line x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '" stroke="#C9773A" stroke-dasharray="4 3" stroke-width="1.5"/>');
      out.push('<text x="' + (W - padR) + '" y="' + (ty - 4) + '" text-anchor="end" class="sv-axis">目标 ' + target + "</text>");
    }
    var emaD = [], rawD = [];
    series.forEach(function (s, i) {
      if (s.ema != null) emaD.push((emaD.length ? "L" : "M") + xOf(i).toFixed(1) + " " + yOf(s.ema).toFixed(1));
      if (s.weight != null) rawD.push((rawD.length ? "L" : "M") + xOf(i).toFixed(1) + " " + yOf(s.weight).toFixed(1));
    });
    if (rawD.length) out.push('<path d="' + rawD.join(" ") + '" fill="none" stroke="var(--jz-muted)" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/>');
    if (emaD.length) out.push('<path d="' + emaD.join(" ") + '" fill="none" stroke="var(--jz-accent)" stroke-width="2.4"/>');
    var cheat = {};
    S.daily.forEach(function (d) { if (d.cheat) cheat[d.date] = 1; });
    series.forEach(function (s, i) {
      if (s.weight == null) return;
      if (cheat[s.date]) out.push('<circle cx="' + xOf(i) + '" cy="' + yOf(s.weight) + '" r="3.5" fill="var(--jz-raised)" stroke="#C9773A" stroke-width="1.6"/>');
    });
    out.push('<text x="' + padL + '" y="' + (H - 4) + '" class="sv-axis">' + series[0].date.slice(5) + "</text>");
    out.push('<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" class="sv-axis">' + series[series.length - 1].date.slice(5) + "</text>");
    out.push("</svg>");
    box.innerHTML = out.join("");
  }

  function svgEmpty(msg) {
    return '<svg class="chart-svg" viewBox="0 0 320 40" preserveAspectRatio="xMidYMid meet"><text x="0" y="22" class="sv-lbl">' + msg + "</text></svg>";
  }

  function renderCalories() {
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    var rec = todayRecord();
    var weightRef = (rec && rec.weight != null) ? rec.weight : (st ? st.ema : null);
    if (!weightRef || !S.profile.height || !S.profile.age) {
      $("calTag").textContent = "资料不全";
      $("calChart").innerHTML = svgEmpty("补全身高、年龄，就能算出每日消耗构成");
      $("intakeChart").innerHTML = "";
      $("defChart").innerHTML = "";
      $("cheatChart").innerHTML = "";
      return;
    }
    var ex = E.expenditure(weightRef, S.profile, rec);
    var pace = E.planPace(st && st.ema || weightRef, S.profile.targetWeight, S.profile.targetDate, S.today);
    var planDef = null;
    if (pace && pace.needPerWeek != null) {
      var used = pace.unsafe ? pace.cap : pace.needPerWeek;
      planDef = Math.round(used * 7700 / 7);
    }
    var budget = Math.max(1200, ex.total - (planDef || 0));
    $("calTag").textContent = ex.movementSource === "steps" ? "按步数估算" : "按活动量估算";
    $("calChart").innerHTML = renderCalStack(ex);
    $("intakeChart").innerHTML = renderIntakeChart(rec, budget);
    $("defChart").innerHTML = renderDeficitChart(st ? E.deficitFromTrend(st.r) : null, planDef, pace && pace.unsafe);
    $("cheatChart").innerHTML = renderCheatChart(E.cheatStats(S.daily, series));
  }

  function renderCalStack(ex) {
    var W = 320, H = 86, y = 14, h = 30;
    var segs = [
      { k: "基础代谢", v: ex.bmr, c: "var(--jz-accent)" },
      { k: "日常活动", v: ex.movement, c: "#c9a24a" },
      { k: "运动", v: ex.workout || 0, c: "#8fd1ab" }
    ].filter(function (s) { return s.v > 0; });
    var total = ex.total || 1, x = 0, out = [];
    out.push('<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">');
    out.push('<text x="0" y="9" class="sv-lbl">每日消耗构成</text>');
    out.push('<text x="' + W + '" y="9" text-anchor="end" class="sv-strong">' + total + " 千卡</text>");
    segs.forEach(function (s, i) {
      var w = Math.max(0, Math.round(s.v / total * W));
      if (i === segs.length - 1) w = W - x;
      out.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + s.c + '"' + (i === 0 || i === segs.length - 1 ? ' rx="6"' : "") + "></rect>");
      if (w >= 46) out.push('<text x="' + (x + w / 2) + '" y="' + (y + h / 2 + 4) + '" text-anchor="middle" class="sv-on">' + s.v + "</text>");
      x += w;
    });
    var ly = 64, colW = W / segs.length;
    segs.forEach(function (s, i) {
      out.push('<circle cx="' + (i * colW + 4) + '" cy="' + (ly - 4) + '" r="4" fill="' + s.c + '"></circle>');
      out.push('<text x="' + (i * colW + 13) + '" y="' + ly + '" class="sv-lbl">' + s.k + " " + s.v + "</text>");
    });
    out.push("</svg>");
    return out.join("");
  }

  function renderIntakeChart(rec, budget) {
    var s = E.dietSummary(rec, budget);
    if (!s.meals.length) return svgEmpty("写一句今天吃了什么，拆成三餐后这里会显示预算");
    var W = 320, H = 100, barH = 24, y = 26;
    var used = s.kcal, ratio = Math.max(0, Math.min(1, used / (s.budget || 1)));
    var w = Math.round(ratio * W), over = used > s.budget;
    var color = over ? "#B4322B" : (s.complete ? "#2F6D5F" : "#D08C3C");
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">'];
    out.push('<text x="0" y="10" class="sv-lbl">今日摄入 · 已记 ' + s.recorded + "/3 餐</text>");
    out.push('<text x="' + W + '" y="10" text-anchor="end" class="sv-strong">' + (over ? "超出 " + (used - s.budget) : "剩 " + s.remaining) + " 千卡</text>");
    out.push('<rect x="0" y="' + y + '" width="' + W + '" height="' + barH + '" rx="6" fill="var(--jz-chart-track)"></rect>');
    out.push('<rect x="0" y="' + y + '" width="' + w + '" height="' + barH + '" rx="6" fill="' + color + '"></rect>');
    out.push('<text x="' + W + '" y="' + (y + barH + 16) + '" text-anchor="end" class="sv-axis">预算 ' + s.budget + "</text>");
    out.push('<text x="0" y="' + (H - 6) + '" class="sv-axis">已记 ' + used + " 千卡</text>");
    out.push("</svg>");
    return out.join("");
  }

  function renderDeficitChart(defTrend, planDef, capped) {
    var W = 320, H = 96;
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">'];
    out.push('<text x="0" y="10" class="sv-lbl">每日热量缺口' + (capped ? "（已按安全上限计算）" : "") + "</text>");
    var vals = [];
    if (planDef != null) vals.push(Math.abs(planDef));
    if (defTrend != null) vals.push(Math.abs(defTrend));
    if (!vals.length) {
      out.push('<text x="0" y="42" class="sv-lbl">记录满一周后，这里会用体重趋势反推真实缺口</text></svg>');
      return out.join("");
    }
    var max = Math.max.apply(null, vals) * 1.25 || 1;
    var rows = [];
    if (planDef != null) rows.push({ k: "计划", v: Math.abs(planDef), c: "#8a8680" });
    if (defTrend != null) rows.push({ k: "实测", v: Math.abs(defTrend), c: "#2F6D5F" });
    rows.forEach(function (r, i) {
      var yy = 26 + i * 30, w = Math.max(3, Math.round(r.v / max * (W - 96)));
      out.push('<text x="0" y="' + (yy + 13) + '" class="sv-lbl">' + r.k + "</text>");
      out.push('<rect x="36" y="' + yy + '" width="' + w + '" height="18" rx="4" fill="' + r.c + '"></rect>');
      out.push('<text x="' + (36 + w + 8) + '" y="' + (yy + 13) + '" class="sv-strong">−' + r.v + "</text>");
    });
    out.push("</svg>");
    return out.join("");
  }

  function renderCheatChart(cs) {
    if (!cs.total) return "";
    var W = 320, H = 102, base = 78, top = 30, weeks = [], today = S.today;
    for (var i = 7; i >= 0; i--) {
      var end = E.addDays(today, -i * 7);
      weeks.push({ start: E.addDays(end, -6), end: end, count: 0, label: E.addDays(end, -6).slice(5).replace("-", "/") });
    }
    S.daily.forEach(function (d) {
      if (!d.cheat) return;
      for (var w = 0; w < weeks.length; w++) if (d.date >= weeks[w].start && d.date <= weeks[w].end) { weeks[w].count++; break; }
    });
    var maxC = Math.max.apply(null, weeks.map(function (w) { return w.count; }).concat([1]));
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">'];
    out.push('<text x="0" y="10" class="sv-lbl">放纵餐分布 · 近 8 周</text>');
    var colW = W / weeks.length, barW = Math.min(20, colW - 8);
    weeks.forEach(function (w, i) {
      var cx = i * colW + colW / 2;
      out.push('<rect x="' + (cx - barW / 2) + '" y="' + top + '" width="' + barW + '" height="' + (base - top) + '" rx="3" fill="var(--jz-chart-track)"></rect>');
      if (w.count > 0) {
        var bh = Math.max(8, (w.count / maxC) * (base - top));
        out.push('<rect x="' + (cx - barW / 2) + '" y="' + (base - bh) + '" width="' + barW + '" height="' + bh + '" rx="3" fill="#C9773A"></rect>');
      }
      out.push('<text x="' + cx + '" y="' + (base + 14) + '" text-anchor="middle" class="sv-axis">' + w.label + "</text>");
    });
    out.push("</svg>");
    return out.join("");
  }

  function renderAI() {
    var body = $("aiBody"), tag = $("aiTag");
    if (!AI_RESULT) {
      tag.textContent = "待分析";
      body.innerHTML = '<div class="ai-empty">记录满 3 天后，这里会判断你的曲线、变化速度与预测可信度。</div>';
      return;
    }
    var r = AI_RESULT;
    tag.textContent = r.source === "ai" ? "AI 判断" : "本地判断";
    body.innerHTML = '<div class="ai-verdict ' + (r.level || "") + '">' + (r.verdict || "") + "</div>" +
      (r.points && r.points.length ? '<ul class="ai-points">' + r.points.map(function (p) { return "<li>" + p + "</li>"; }).join("") + "</ul>" : "") +
      (r.tip ? '<div class="ai-tip">' + r.tip + "</div>" : "");
  }

  function runAI(force) {
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    if (!st || st.recorded7 < 3) { if (force) toast("再记几天再分析"); return; }
    var p = S.profile.targetWeight ? E.predict(series, S.profile.targetWeight, { targetDate: S.profile.targetDate }) : null;
    var last14 = series.slice(-14).map(function (s) { return { d: s.date, w: s.weight, ema: s.ema == null ? null : Math.round(s.ema * 10) / 10 }; });
    api("POST", "/api/jianzhi/ai", {
      kind: "analyze", ema: st.ema, r: st.r, recorded7: st.recorded7, recorded28: st.recorded28,
      target: S.profile.targetWeight, reachDate: p && p.reachDate, stalled: p && p.stalled, last14: last14
    }).then(function (d) {
      AI_RESULT = d;
      renderAI();
    }).catch(function () {
      if (force) toast("AI 暂时不可用，已用本地规则");
      AI_RESULT = E.localAnalysis({ stats: st, profile: S.profile, cheatStats: E.cheatStats(S.daily, series) });
      renderAI();
    });
  }

  function renderAchievements() {
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    var list = E.achievements({ series: series, daily: S.daily, profile: S.profile, stats: st, cheatStats: E.cheatStats(S.daily, series) });
    var got = list.filter(function (a) { return a.earned; }).length;
    $("achTag").textContent = got + "/" + list.length;
    $("achStrip").innerHTML = list.map(function (a) {
      return '<div class="ach' + (a.earned ? " earned" : "") + '"><div class="ring">' +
        (a.earned ? "✓" : Math.round((a.progress || 0) * 100) + "%") + '</div><div class="name">' + a.name + "</div></div>";
    }).join("");
  }

  function renderWaist() {
    var last = lastMeasure();
    if (last) {
      $("waistInput").value = last.waist || "";
      $("hipInput").value = last.hip || "";
      $("thighInput").value = last.thigh || "";
      $("waistTag").textContent = "上次 " + last.date.slice(5);
      $("waistNote").textContent = "上次记录：" + last.date.slice(5) + " 腰围 " + (last.waist || "—") + " cm";
    } else {
      $("waistTag").textContent = "每周一次";
    }
    renderWaistChart();
  }

  function renderWaistChart() {
    var box = $("waistChart");
    var list = (S.measurements || []).filter(function (m) { return m.waist; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (list.length < 2) {
      box.innerHTML = list.length ? '<div class="week-note">再量一次，这里会出现腰围趋势。</div>' : "";
      return;
    }
    var W = 320, H = 120, padL = 32, padR = 8, padT = 10, padB = 22;
    var vals = list.map(function (m) { return +m.waist; });
    var min = Math.min.apply(null, vals) - 1, max = Math.max.apply(null, vals) + 1;
    function xOf(i) { return padL + (W - padL - padR) * i / (list.length - 1); }
    function yOf(v) { return padT + (H - padT - padB) * (max - v) / (max - min || 1); }
    var d = list.map(function (m, i) { return (i ? "L" : "M") + xOf(i).toFixed(1) + " " + yOf(m.waist).toFixed(1); }).join(" ");
    var out = ['<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">'];
    out.push('<text x="0" y="10" class="sv-lbl">腰围趋势 (cm)</text>');
    out.push('<path d="' + d + '" fill="none" stroke="var(--jz-accent)" stroke-width="2"/>');
    list.forEach(function (m, i) {
      out.push('<circle cx="' + xOf(i) + '" cy="' + yOf(m.waist) + '" r="2.5" fill="var(--jz-accent)"/>');
    });
    out.push('<text x="' + padL + '" y="' + (H - 4) + '" class="sv-axis">' + list[0].date.slice(5) + "</text>");
    out.push('<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" class="sv-axis">' + list[list.length - 1].date.slice(5) + " · " + list[list.length - 1].waist + "</text>");
    out.push("</svg>");
    box.innerHTML = out.join("");
  }

  function renderRecent() {
    var box = $("recentList");
    var list = S.daily.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (!list.length) { box.innerHTML = '<div class="week-note">还没有记录。</div>'; return; }
    box.innerHTML = list.map(function (d) {
      var prev = lastRecordBefore(d.date);
      var delta = (prev && d.weight != null) ? d.weight - prev.weight : null;
      var diet = d.diet ? E.mealsOf(d).length ? ("已记 " + E.mealsOf(d).length + " 餐") : d.diet : "";
      return '<div class="rec-row" data-date="' + d.date + '"><div><div>' + d.date.slice(5) + " " + E.formatWeekday(d.date) +
        (d.cheat ? " · 放纵" : "") + (diet ? ' <span class="meta">' + diet + "</span>" : "") +
        "</div></div><div><b>" + (d.weight != null ? fmt(d.weight) + " kg" : "—") + "</b> " +
        (delta != null ? '<span class="meta">' + signed(delta) + "</span>" : "") + "</div></div>";
    }).join("");
  }

  /* ---------- 保存 ---------- */
  function collectTodayBody() {
    var rec = todayRecord() || {};
    return {
      date: S.today,
      weight: $("weightInput").value === "" ? (rec.weight != null ? rec.weight : null) : Number($("weightInput").value),
      sleep: $("sleepInput").value === "" ? null : Number($("sleepInput").value),
      steps: $("stepsInput").value === "" ? null : Number($("stepsInput").value),
      workouts: WK_LIST,
      cheat: $("cheatInput").checked,
      diet: ($("dietInput").value || rec.diet || "").trim(),
      meals: E.mealsOf(rec),
      note: rec.note || ""
    };
  }

  function saveToday(force) {
    var input = $("weightInput");
    var w = parseFloat(input.value);
    if (!isFinite(w) || w < 20 || w > 400) { toast("请输入 20—400 之间的体重"); input.focus(); return; }
    var last = lastRecordBefore(S.today);
    if (!force && last && Math.abs(w - last.weight) > 2) {
      var ok = confirm("与上次（" + last.date.slice(5) + "，" + last.weight + " kg）相差超过 2 公斤，确认保存吗？");
      if (ok) saveToday(true);
      return;
    }
    var body = collectTodayBody();
    body.weight = w;
    $("btnSave").disabled = true;
    upsertLocalDaily(body);
    renderAll();
    api("PUT", "/api/jianzhi/daily/" + S.today, body).then(function (d) {
      $("btnSave").disabled = false;
      if (d.record) upsertLocalDaily(d.record);
      setSync("synced");
      renderAll();
      toast("已记录");
    }).catch(function (e) {
      $("btnSave").disabled = false;
      queue({ op: "putDaily", date: S.today, body: body });
      setSync("offline");
      toast("网络不可用，已暂存本地，联网后自动补记");
    });
  }

  function saveWaist() {
    var waist = parseFloat($("waistInput").value);
    if (!isFinite(waist)) { toast("请填写腰围"); return; }
    var body = {
      date: S.today,
      waist: waist,
      hip: $("hipInput").value === "" ? null : Number($("hipInput").value),
      thigh: $("thighInput").value === "" ? null : Number($("thighInput").value)
    };
    var list = S.measurements.slice();
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].date === S.today) i = k;
    if (i >= 0) list[i] = Object.assign({}, list[i], body); else list.push(body);
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    S.measurements = list;
    cacheState();
    renderWaist();
    renderBmi(todayRecord());
    api("PUT", "/api/jianzhi/measurement/" + S.today, body).then(function (d) {
      if (d.record) {
        S.measurements = S.measurements.filter(function (m) { return m.date !== S.today; }).concat([d.record]);
        S.measurements.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        cacheState();
      }
      toast("围度已保存");
    }).catch(function () {
      queue({ op: "putMeasure", date: S.today, body: body });
      toast("网络不可用，围度已暂存本地");
    });
  }

  /* 饮食：每天一句话，AI 拆三餐 */
  function estimateDiet() {
    var text = ($("dietInput").value || "").trim();
    if (!text) { toast("先写一句今天吃了什么"); $("dietInput").focus(); return; }
    var btn = $("btnDiet");
    btn.disabled = true;
    btn.textContent = "拆…";
    var rec = todayRecord() || { date: S.today };
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    var weightRef = (rec.weight != null) ? rec.weight : (st && st.ema);
    var budget = null;
    if (weightRef && S.profile.height && S.profile.age) {
      var ex = E.expenditure(weightRef, S.profile, rec);
      if (ex) budget = ex.total;
    }
    function apply(result, source) {
      rec.diet = text;
      rec.meals = result.meals || [];
      rec.dietKcal = result.kcal;
      if (!findRec(S.today)) S.daily.push(rec);
      else upsertLocalDaily(rec);
      cacheState();
      renderMeals(rec);
      $("dietResult").innerHTML = (source === "ai" ? '<span class="diet-src">AI</span>' : '<span class="diet-src local">本地</span>') +
        " 约 " + (result.kcal || "—") + " 千卡" + (result.advice ? " · " + result.advice : "");
      renderCalories();
      renderRecent();
    }
    api("POST", "/api/jianzhi/ai", { kind: "diet", text: text, budget: budget }).then(function (d) {
      btn.disabled = false; btn.textContent = "拆成三餐并估算";
      apply(d, "ai");
      persistDiet(rec);
    }).catch(function () {
      btn.disabled = false; btn.textContent = "拆成三餐并估算";
      apply(E.localDietSplit(text), "local");
      persistDiet(rec);
      toast("AI 暂时不可用，已用本地规则拆分");
    });
  }

  function persistDiet(rec) {
    if (rec.weight == null && !rec.meals.length) return;
    var body = Object.assign({}, rec);
    var go = function () {
      api("PUT", "/api/jianzhi/daily/" + rec.date, body).then(function (d) {
        if (d.record) upsertLocalDaily(d.record);
      }).catch(function () { queue({ op: "putDaily", date: rec.date, body: body }); });
    };
    if (rec.weight == null) go();
    else go();
  }

  function removeMeal(slot) {
    var rec = todayRecord();
    if (!rec || !rec.meals) return;
    rec.meals = rec.meals.filter(function (m) { return m.slot !== slot; });
    rec.dietKcal = rec.meals.reduce(function (a, m) { return a + (+m.kcal || 0); }, 0);
    upsertLocalDaily(rec);
    renderMeals(rec);
    renderCalories();
    persistDiet(rec);
  }

  /* 运动 */
  function openWorkout() {
    $("wkMask").classList.add("on");
    renderWkList();
    if (!$("metGrid").children.length) {
      $("metGrid").innerHTML = E.METS.map(function (m) {
        return '<button type="button" class="met-chip" data-met="' + m.key + '">' + m.label + "</button>";
      }).join("");
    }
  }
  function renderWkList() {
    $("wkList").innerHTML = WK_LIST.map(function (w, i) {
      return '<div class="wk-item"><span>' + E.metLabel(w.type) + " " + (w.min || "—") + " min · " + (w.kcal || "—") +
        ' kcal</span><button type="button" data-i="' + i + '">×</button></div>';
    }).join("");
  }
  function calcWorkout() {
    if (!WK.type) return;
    var min = Number($("wkMin").value) || 0;
    var w = (todayRecord() && todayRecord().weight) || S.profile.startWeight || 70;
    WK.min = min;
    WK.kcal = E.workoutKcal(WK.type, min, w);
    $("wkKcal").value = WK.kcal || "";
  }
  function addWorkout() {
    if (!WK.type) { toast("先选一种运动"); return; }
    var min = Number($("wkMin").value) || WK.min;
    var kcal = Number($("wkKcal").value) || WK.kcal;
    if (!min) { toast("请填写时长"); return; }
    WK_LIST.push({ type: WK.type, min: min, kcal: kcal });
    renderWkList();
    syncWorkoutLabel();
  }
  function removeWorkout(i) {
    WK_LIST.splice(i, 1);
    renderWkList();
    syncWorkoutLabel();
  }

  /* 设置 */
  function bindDateFmt(inputId, labelId) {
    var inp = $(inputId), lab = $(labelId);
    if (!inp || !lab) return;
    function upd() { lab.textContent = inp.value ? fmtDateCN(inp.value) : ""; }
    inp.addEventListener("input", upd);
    inp.addEventListener("change", upd);
    upd();
  }
  function openSettings() {
    $("pHeight").value = S.profile.height || "";
    $("pAge").value = S.profile.age || "";
    $("pSex").value = S.profile.sex || "male";
    $("pActivity").value = S.profile.activity || "sedentary";
    $("pStart").value = S.profile.startWeight || "";
    $("pTarget").value = S.profile.targetWeight || "";
    $("pDate").value = S.profile.targetDate || "";
    bindDateFmt("pDate", "pDateFmt");
    $("pDateFmt").textContent = $("pDate").value ? fmtDateCN($("pDate").value) : "";
    $("mask").classList.add("on");
  }
  function saveProfile() {
    var body = {
      height: $("pHeight").value, age: $("pAge").value, sex: $("pSex").value,
      activity: $("pActivity").value, startWeight: $("pStart").value,
      targetWeight: $("pTarget").value, targetDate: $("pDate").value || ""
    };
    if (!body.targetWeight) { toast("请填写目标体重"); return; }
    S.profile = Object.assign({}, S.profile, {
      height: Number(body.height) || S.profile.height,
      age: Number(body.age) || S.profile.age,
      sex: body.sex, activity: body.activity,
      startWeight: Number(body.startWeight) || S.profile.startWeight,
      targetWeight: Number(body.targetWeight),
      targetDate: body.targetDate
    });
    cacheState();
    $("mask").classList.remove("on");
    renderAll();
    api("PUT", "/api/jianzhi/profile", body).then(function (d) {
      if (d.profile) S.profile = d.profile;
      cacheState();
      toast("设置已保存");
    }).catch(function () {
      queue({ op: "putProfile", body: body });
      toast("设置已暂存本地，联网后同步");
    });
  }

  /* 补记 / 编辑 */
  function suggestedBackfillDate() {
    var t = S.today, d = E.addDays(t, -1);
    for (var i = 0; i < 60; i++) {
      if (!findRec(d)) return d;
      d = E.addDays(d, -1);
    }
    return E.addDays(t, -1);
  }
  function openRecord(date, isNew) {
    var rec = findRec(date);
    REC_EDIT = { date: date || S.today, isNew: !!isNew && !rec };
    $("recTitle").textContent = REC_EDIT.isNew ? "补记以前的日期" : "编辑记录 " + (date || "").slice(5);
    $("rDate").value = REC_EDIT.isNew ? (date && date !== S.today ? date : suggestedBackfillDate()) : (date || S.today);
    $("rDate").disabled = !REC_EDIT.isNew;
    $("rDate").max = S.today;
    $("rDateFmt").textContent = fmtDateCN($("rDate").value);
    rec = findRec($("rDate").value) || rec;
    $("rWeight").value = rec && rec.weight != null ? rec.weight : "";
    $("rSleep").value = rec && rec.sleep != null ? rec.sleep : "";
    $("rSteps").value = rec && rec.steps != null ? rec.steps : "";
    var wkList = rec && rec.workouts ? rec.workouts : [];
    REC_EDIT.hasWorkouts = wkList.length > 0;
    $("rWorkout").disabled = REC_EDIT.hasWorkouts;
    $("rWorkout").value = rec && rec.workout != null ? rec.workout : "";
    var mealList = rec && rec.meals ? rec.meals : [];
    REC_EDIT.hasMeals = mealList.length > 0;
    $("rDiet").disabled = REC_EDIT.hasMeals;
    $("rDiet").placeholder = REC_EDIT.hasMeals ? "已拆成三餐，请在今日卡里改" : "一句话";
    $("rDiet").value = rec && rec.diet && !REC_EDIT.hasMeals ? rec.diet : (rec && rec.diet ? rec.diet : "");
    $("rNote").value = rec && rec.note ? rec.note : "";
    $("rCheat").checked = !!(rec && rec.cheat);
    $("recDelete").hidden = REC_EDIT.isNew;
    $("recMask").classList.add("on");
  }
  function saveRecord() {
    var date = $("rDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast("请选择日期"); return; }
    if (date > S.today) { toast("不能记未来的日期"); return; }
    var w = parseFloat($("rWeight").value);
    if (!isFinite(w) || w < 20 || w > 400) { toast("体重请填 20—400"); return; }
    var existing = findRec(date) || {};
    var body = {
      date: date, weight: w,
      sleep: $("rSleep").value === "" ? null : Number($("rSleep").value),
      steps: $("rSteps").value === "" ? null : Number($("rSteps").value),
      note: ($("rNote").value || "").trim(),
      cheat: $("rCheat").checked,
      diet: REC_EDIT.hasMeals ? (existing.diet || "") : ($("rDiet").value || "").trim(),
      meals: REC_EDIT.hasMeals ? (existing.meals || []) : existing.meals,
      workouts: REC_EDIT.hasWorkouts ? (existing.workouts || []) : existing.workouts
    };
    if (!REC_EDIT.hasWorkouts && $("rWorkout").value !== "") body.workout = Number($("rWorkout").value);
    upsertLocalDaily(body);
    $("recMask").classList.remove("on");
    renderAll();
    api("PUT", "/api/jianzhi/daily/" + date, body).then(function (d) {
      if (d.record) upsertLocalDaily(d.record);
      toast("已保存");
      renderAll();
    }).catch(function () {
      queue({ op: "putDaily", date: date, body: body });
      toast("已暂存本地，联网后同步");
    });
  }
  function deleteRecord() {
    var date = REC_EDIT.date;
    if (!date) return;
    if (!confirm("删除 " + date + " 的记录？该条体重和饮食都会移除。")) return;
    removeLocalDaily(date);
    $("recMask").classList.remove("on");
    renderAll();
    api("DELETE", "/api/jianzhi/daily/" + date).then(function () {
      toast("已删除");
    }).catch(function () {
      queue({ op: "delDaily", date: date });
      toast("删除已暂存，联网后同步");
    });
  }

  /* ---------- 照片 IndexedDB ---------- */
  var DB_NAME = "zn-jianzhi-photos", DB_VER = 1;
  function idb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains("photos")) {
          var os = db.createObjectStore("photos", { keyPath: "id" });
          os.createIndex("date", "date");
          os.createIndex("angle", "angle");
        }
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function uid() { return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function loadPhotos() {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("photos", "readonly");
        var req = tx.objectStore("photos").getAll();
        req.onsuccess = function () {
          PHOTOS = (req.result || []).sort(function (a, b) { return a.date < b.date ? 1 : (a.createdAt < b.createdAt ? 1 : -1); });
          resolve(PHOTOS);
        };
        req.onerror = function () { resolve(PHOTOS); };
      });
    }).catch(function () { return PHOTOS; });
  }
  function savePhoto(rec) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("photos", "readwrite");
        tx.objectStore("photos").put(rec);
        tx.oncomplete = function () { resolve(rec); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function deletePhoto(id) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("photos", "readwrite");
        tx.objectStore("photos").delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    });
  }
  function photoUrl(p) {
    if (p._url) return p._url;
    if (p.blob) p._url = URL.createObjectURL(p.blob);
    else if (p.dataUrl) p._url = p.dataUrl;
    return p._url || "";
  }
  function renderPhotos() {
    var row = $("photoRow");
    if (!row) return;
    if (!PHOTOS.length) {
      row.innerHTML = "";
      $("photoTag").textContent = "每周一次 · 只留本机";
      return;
    }
    $("photoTag").textContent = PHOTOS.length + " 张 · 只留本机";
    row.innerHTML = PHOTOS.slice(0, 24).map(function (p) {
      return '<div class="photo-thumb" data-id="' + p.id + '"><img src="' + photoUrl(p) + '" alt="' + p.date + '">' +
        '<div class="cap">' + p.date.slice(5) + " · " + angleLabel(p.angle) + "</div></div>";
    }).join("");
  }
  function angleLabel(a) { return ({ front: "正面", side: "侧面", back: "背面", other: "其他" })[a] || "正面"; }

  function renderCompare() {
    var box = $("photoCompare");
    var angle = $("cmpAngle") ? $("cmpAngle").value : "front";
    var list = PHOTOS.filter(function (p) { return (p.angle || "front") === angle; })
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : 1); });
    if (list.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    CMP.a = list[0];
    CMP.b = list[list.length - 1];
    $("cmpLeft").src = photoUrl(CMP.a);
    $("cmpRight").src = photoUrl(CMP.b);
    $("cmpLeftCap").textContent = "较早 · " + CMP.a.date.slice(5);
    $("cmpRightCap").textContent = "较新 · " + CMP.b.date.slice(5);
    updateOverlay();
  }
  function updateOverlay() {
    if (!CMP.a || !CMP.b) return;
    var ov = $("cmpOverlay");
    ov.hidden = false;
    $("cmpOverA").src = photoUrl(CMP.a);
    $("cmpOverB").src = photoUrl(CMP.b);
    var v = Number($("cmpSlider").value) || 50;
    $("cmpClip").style.width = v + "%";
    $("cmpClip").style.setProperty("--cut", String(v));
  }

  function pickPhoto(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        var max = 900;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
          var rec = {
            id: uid(), date: S.today, angle: $("photoAngle").value || "front",
            mime: "image/jpeg", blob: blob, w: c.width, h: c.height, createdAt: Date.now()
          };
          savePhoto(rec).then(function () {
            return loadPhotos();
          }).then(function () {
            renderPhotos();
            if ($("cmpAngle")) $("cmpAngle").value = rec.angle;
            renderCompare();
            $("photoNote").textContent = "已保存在这台设备。" + angleLabel(rec.angle) + "，同一角度再拍一张就能对比。";
          }).catch(function () { $("photoNote").textContent = "这台设备没法存照片（浏览器限制）"; });
        }, "image/jpeg", 0.82);
      };
      img.onerror = function () { toast("这张图读不出来"); };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  function exportAchCard() {
    var series = E.buildSeries(S.daily, S.today);
    var st = E.stats(series);
    if (!st) { toast("先记几天数据"); return; }
    var list = E.achievements({ series: series, daily: S.daily, profile: S.profile, stats: st, cheatStats: E.cheatStats(S.daily, series) });
    var got = list.filter(function (a) { return a.earned; });
    var start = Number(S.profile.startWeight) || (series[0].ema || st.ema);
    var lost = start - st.ema;
    var W = 750, H = 1000;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    g.fillStyle = "#080809"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#121214"; g.fillRect(0, 0, W, 620);
    g.fillStyle = "#e8c878"; g.fillRect(0, 0, W, 8);
    g.fillStyle = "#9a958b"; g.font = "24px sans-serif"; g.fillText("减值记录 · 壮尼Ni", 60, 80);
    g.fillStyle = "#f3f0e8"; g.font = "bold 40px sans-serif";
    var d = E.parseISO(S.today);
    g.fillText(d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月", 60, 136);
    g.fillStyle = "#8fd1ab"; g.font = "bold 88px sans-serif";
    g.fillText((lost >= 0 ? "−" : "+") + Math.abs(lost).toFixed(1) + " kg", 60, 240);
    g.fillStyle = "#9a958b"; g.font = "24px sans-serif";
    g.fillText(start.toFixed(1) + " → " + st.ema.toFixed(1) + " kg", 62, 285);
    var pts = series.slice(-45).filter(function (p) { return p.ema != null; });
    if (pts.length > 1) {
      var x0 = 60, y0 = 330, w = W - 120, h = 220;
      var vals = pts.map(function (p) { return p.ema; });
      var min = Math.min.apply(null, vals) - 0.4, max = Math.max.apply(null, vals) + 0.4;
      g.strokeStyle = "rgba(243,240,232,0.12)"; g.lineWidth = 2;
      for (var i = 0; i <= 3; i++) {
        var yy = y0 + h * i / 3;
        g.beginPath(); g.moveTo(x0, yy); g.lineTo(x0 + w, yy); g.stroke();
      }
      g.strokeStyle = "#e8c878"; g.lineWidth = 4; g.beginPath();
      pts.forEach(function (p, i) {
        var px = x0 + w * i / (pts.length - 1);
        var py = y0 + h * (max - p.ema) / (max - min || 1);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.stroke();
    }
    g.fillStyle = "#f3f0e8"; g.font = "bold 26px sans-serif";
    g.fillText("已解锁 " + got.length + "/" + list.length, 60, 672);
    g.fillStyle = "#6a665e"; g.font = "20px sans-serif";
    g.fillText("照片与卡片均只存在本机 · " + S.today, 60, H - 40);
    var a2 = document.createElement("a");
    a2.download = "减值记录-" + S.today.slice(0, 7) + ".png";
    a2.href = c.toDataURL("image/png");
    a2.click();
    toast("卡片已生成");
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    document.querySelectorAll(".step-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var input = $("weightInput");
        var v = parseFloat(input.value);
        if (!isFinite(v)) v = Number(S.profile.startWeight) || 60;
        v = Math.round((v + Number(b.dataset.delta)) * 10) / 10;
        input.value = v.toFixed(1);
      });
    });
    $("btnSave").addEventListener("click", function () { saveToday(false); });
    $("weightInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); saveToday(false); }
    });
    $("btnWaist").addEventListener("click", saveWaist);
    $("cheatInput").addEventListener("change", syncCheatStyle);
    $("btnSettings").addEventListener("click", openSettings);
    $("btnCloseSettings").addEventListener("click", function () { $("mask").classList.remove("on"); });
    $("btnSaveProfile").addEventListener("click", saveProfile);
    $("mask").addEventListener("click", function (e) { if (e.target === $("mask")) $("mask").classList.remove("on"); });
    $("pDate").addEventListener("input", function () { $("pDateFmt").textContent = this.value ? fmtDateCN(this.value) : ""; });

    $("btnWorkout").addEventListener("click", openWorkout);
    $("metGrid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-met]");
      if (!b) return;
      WK.type = b.dataset.met;
      $("metGrid").querySelectorAll(".met-chip").forEach(function (x) { x.classList.toggle("on", x === b); });
      calcWorkout();
    });
    $("wkList").addEventListener("click", function (e) {
      var b = e.target.closest("[data-i]");
      if (b) removeWorkout(Number(b.dataset.i));
    });
    $("wkMin").addEventListener("input", calcWorkout);
    $("wkSave").addEventListener("click", addWorkout);
    $("wkCancel").addEventListener("click", function () { $("wkMask").classList.remove("on"); });
    $("wkMask").addEventListener("click", function (e) { if (e.target === $("wkMask")) $("wkMask").classList.remove("on"); });

    $("btnDiet").addEventListener("click", estimateDiet);
    $("mealList").addEventListener("click", function (e) {
      var b = e.target.closest("[data-slot]");
      if (b) removeMeal(b.dataset.slot);
    });

    $("btnAchCard").addEventListener("click", exportAchCard);
    $("btnAI").addEventListener("click", function () { runAI(true); });
    $("btnExport").addEventListener("click", function () {
      if (window.JZXlsx) { window.JZXlsx.download(S.daily, S.today, E); toast("正在导出 Excel"); }
    });
    $("btnAddRec").addEventListener("click", function () { openRecord(suggestedBackfillDate(), true); });
    $("recentList").addEventListener("click", function (e) {
      var row = e.target.closest("[data-date]");
      if (row) openRecord(row.dataset.date, false);
    });
    $("recSave").addEventListener("click", saveRecord);
    $("recDelete").addEventListener("click", deleteRecord);
    $("recCancel").addEventListener("click", function () { $("recMask").classList.remove("on"); });
    $("recMask").addEventListener("click", function (e) { if (e.target === $("recMask")) $("recMask").classList.remove("on"); });
    $("rDate").addEventListener("input", function () { $("rDateFmt").textContent = fmtDateCN(this.value); });

    $("photoInput").addEventListener("change", function (e) {
      pickPhoto(e.target.files && e.target.files[0]);
      e.target.value = "";
    });
    $("cmpAngle").addEventListener("change", renderCompare);
    $("cmpSlider").addEventListener("input", updateOverlay);
    $("syncPill").addEventListener("click", function () { load(true); });

    window.addEventListener("online", function () { flushPending().then(function (ok) { if (ok) load(false); }); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") flushPending(); });
  }

  function boot() {
    bind();
    S.today = todayBJ();
    applyCache();
    renderAll();
    load(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
