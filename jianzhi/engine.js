/* 减值记录 — 计算引擎（前后端共用，零依赖）
 * EMA 趋势 / 周变化率 / 达成预测 / 可信度
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var ALPHA = 0.3;
  var DECAY = 0.85;      // 代谢衰减系数
  var MIN_SLOPE = 0.01;  // 每周变化小于此值视为停滞（kg/周）

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function toISO(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseISO(s) {
    var p = String(s).split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function addDays(iso, n) {
    var d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function diffDays(a, b) {
    return Math.round((parseISO(b) - parseISO(a)) / 86400000);
  }

  /* 「今天」统一按北京时间（UTC+8），与计划拆解 / 学习页一致 */
  function todayISO(ms) {
    var n = ms == null ? Date.now() : ms;
    return new Date(n + 8 * 3600000).toISOString().slice(0, 10);
  }

  /* 生成连续日序列：缺失日沿用前一日 EMA（趋势不动），原始体重为 null */
  function buildSeries(records, endDate) {
    var list = records
      .filter(function (r) { return r && r.date && isFinite(+r.weight) && +r.weight > 0; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (!list.length) return [];

    var start = list[0].date;
    var end = endDate || todayISO();
    if (end < start) end = start;

    var map = {};
    list.forEach(function (r) { map[r.date] = +r.weight; });

    var out = [];
    var ema = null;
    var cur = start;
    var guard = 0;
    while (cur <= end && guard++ < 20000) {
      var w = map.hasOwnProperty(cur) ? map[cur] : null;
      if (w != null) ema = ema == null ? w : ALPHA * w + (1 - ALPHA) * ema;
      else if (ema == null) ema = null;
      out.push({ date: cur, weight: w, ema: ema });
      cur = addDays(cur, 1);
    }
    return out;
  }

  function emaOn(series, iso) {
    for (var i = series.length - 1; i >= 0; i--) {
      if (series[i].date === iso) return series[i].ema;
      if (series[i].date < iso) return series[i].ema;
    }
    return null;
  }

  /* 核心统计 */
  function stats(series) {
    if (!series.length) return null;
    var last = series[series.length - 1];
    var emaNow = last.ema;
    if (emaNow == null) return null;

    var weekAgo = addDays(last.date, -7);
    var emaWeekAgo = emaOn(series, weekAgo);
    var r = (emaNow != null && emaWeekAgo != null) ? (emaNow - emaWeekAgo) : null;

    // 上一条有效体重的差值
    var prevW = null;
    for (var i = series.length - 2; i >= 0; i--) {
      if (series[i].weight != null) { prevW = series[i].weight; break; }
    }
    var lastW = last.weight;
    var dayDiff = (lastW != null && prevW != null) ? (lastW - prevW) : null;

    // 近 28 天记录天数 / 覆盖率
    var last28 = series.slice(-28);
    var rec28 = last28.filter(function (d) { return d.weight != null; }).length;
    var fresh7 = series.slice(-7).filter(function (d) { return d.weight != null; }).length;

    return {
      date: last.date,
      weight: lastW,
      ema: emaNow,
      r: r,
      dayDiff: dayDiff,
      totalDays: series.length,
      recorded28: rec28,
      recorded7: fresh7,
      coverage: last28.length ? rec28 / last28.length : 0,
      startWeight: series[0].weight || emaNow
    };
  }

  /* 斜率标准差 → 预测区间宽度（周） */
  function slopeSD(series, r) {
    var pts = series.slice(-30);
    var slopes = [];
    for (var i = 7; i < pts.length; i++) {
      if (pts[i].ema != null && pts[i - 7].ema != null) {
        slopes.push(pts[i].ema - pts[i - 7].ema);
      }
    }
    if (slopes.length < 4) return null;
    var mean = slopes.reduce(function (a, b) { return a + b; }, 0) / slopes.length;
    var v = slopes.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (slopes.length - 1);
    return Math.sqrt(v);
  }

  function confidence(st, s) {
    if (!st || !st.recorded7) return { level: "none", text: "再记 3 天即可生成预测", width: 0 };
    if (st.totalDays < 7 || st.recorded7 < 3) return { level: "none", text: "再记 " + Math.max(1, 7 - st.recorded7) + " 天即可生成预测", width: 0 };
    if (st.recorded28 < 14) return { level: "low", text: "初步", width: 1.8 };
    if (st.recorded28 < 28) return { level: "mid", text: "中等", width: 1.2 };
    return { level: "high", text: "较高", width: 0.8 };
  }

  /* 预测主函数 */
  function predict(series, target, opts) {
    opts = opts || {};
    var st = stats(series);
    if (!st || st.ema == null) return { ok: false, reason: "nodata" };
    var targetW = +target;
    if (!isFinite(targetW) || targetW <= 0) return { ok: false, reason: "notarget" };

    var hasDate = opts.targetDate || null;
    var conf = confidence(st, series);

    var res = {
      ok: true,
      ema: st.ema,
      weight: st.weight,
      r: st.r,
      confidence: conf,
      stalled: false,
      reached: st.ema <= targetW,
      planDaysLeft: hasDate ? diffDays(st.date, hasDate) : null,
      monthOut: (st.r != null) ? st.ema + st.r * 4 : null,
      scenarios: []
    };

    if (res.reached) {
      res.reached = true;
      res.weeks = 0;
      res.reachDate = st.date;
      return res;
    }

    if (st.r == null || st.r > -MIN_SLOPE) {
      res.stalled = true;
      res.weeks = null;
      res.reachDate = null;
      if (st.r != null && st.r > 0) {
        res.note = "近期趋势在上升";
      } else {
        res.note = "近期几乎没有变化";
      }
      res.scenarios = scenariosFor(res, st, targetW, series);
      return res;
    }

    var loseRate = -st.r * DECAY;
    var weeks = (st.ema - targetW) / loseRate;

    // 区间
    var sd = slopeSD(series, st.r);
    var w = conf.width;
    if (sd != null) {
      var wpct = sd / Math.max(0.02, loseRate);
      w = Math.max(w, Math.min(6, wpct * 1.5));
    }
    res.weeks = weeks;
    res.reachDate = addDays(st.date, Math.round(weeks * 7));
    res.rangeStart = addDays(res.reachDate, -Math.round(w * 7));
    res.rangeEnd = addDays(res.reachDate, Math.round(w * 7));
    res.rangeWeeks = w;
    res.loseRate = loseRate;
    res.scenarios = scenariosFor(res, st, targetW, series);
    return res;
  }

  function scenariosFor(res, st, targetW, series) {
    var r = st.r == null ? 0 : st.r;
    function weeksWith(rate) {
      if (rate > -MIN_SLOPE) return null;
      var v = (st.ema - targetW) / (-rate * DECAY);
      if (!isFinite(v) || v <= 0 || v > 300) return null;
      return v;
    }
    var base = res.weeks;
    var boost = weeksWith(r - 0.25);
    var relax = weeksWith(r * 0.5);
    return [
      { key: "base", label: "保持现状", weeks: base, date: base ? addDays(st.date, Math.round(base * 7)) : null },
      { key: "boost", label: "加强", weeks: boost, date: boost ? addDays(st.date, Math.round(boost * 7)) : null },
      { key: "relax", label: "松懈", weeks: relax, date: relax ? addDays(st.date, Math.round(relax * 7)) : null }
    ];
  }

  /* 上周预测应该到多少 vs 实际 */
  function calibration(series, forecasts) {
    if (!forecasts || !forecasts.length) return null;
    var st = stats(series);
    if (!st) return null;
    var sorted = forecasts.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var last = sorted[sorted.length - 1];
    if (!last || last.date >= st.date) return null;
    var days = diffDays(last.date, st.date);
    if (days < 5) return null;
    var expected = last.ema + (last.r || 0) / 7 * days;
    var actual = st.ema;
    var dev = actual - expected;
    return {
      from: last.date,
      days: days,
      expected: expected,
      actual: actual,
      deviation: dev,
      weekDeviation: Math.abs(dev / (days / 7))
    };
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var p = iso.split("-");
    return p[0] + " 年 " + (+p[1]) + " 月 " + (+p[2]) + " 日";
  }

  function formatWeekday(iso) {
    var names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return names[parseISO(iso).getDay()];
  }

  /* ---------- 热量参数 ---------- */
  var ACTIVITY_LEVELS = [
    { key: "sedentary", label: "久坐 · 几乎不运动", factor: 1.2 },
    { key: "light", label: "轻度 · 每周 1—3 次", factor: 1.375 },
    { key: "moderate", label: "中度 · 每周 3—5 次", factor: 1.55 },
    { key: "active", label: "高强度 · 每周 6—7 次", factor: 1.725 }
  ];

  function activityFactor(key) {
    for (var i = 0; i < ACTIVITY_LEVELS.length; i++) {
      if (ACTIVITY_LEVELS[i].key === key) return ACTIVITY_LEVELS[i].factor;
    }
    return 1.2;
  }

  function activityLabel(key) {
    for (var i = 0; i < ACTIVITY_LEVELS.length; i++) {
      if (ACTIVITY_LEVELS[i].key === key) return ACTIVITY_LEVELS[i].label;
    }
    return ACTIVITY_LEVELS[0].label;
  }

  /* Mifflin-St Jeor 基础代谢 */
  function bmr(weightKg, heightCm, age, sex) {
    if (!weightKg || !heightCm || !age) return null;
    var v = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === "female" ? -161 : 5);
    return Math.round(v);
  }

  /* 单日消耗：基础代谢 + 日常活动 + 运动 */
  function expenditure(weightKg, profile, rec) {
    var b = bmr(weightKg, profile.height, profile.age, profile.sex);
    if (!b) return null;
    var factor = activityFactor(profile.activity);
    var byFactor = b * (factor - 1);
    var bySteps = rec && rec.steps ? (+rec.steps) * 0.042 : 0;
    var useSteps = bySteps > byFactor;
    var movement = useSteps ? bySteps : byFactor;
    var workout = rec && rec.workout ? +rec.workout : 0;
    return {
      bmr: Math.round(b),
      movement: Math.round(movement),
      movementSource: useSteps ? "steps" : "factor",
      workout: Math.round(workout),
      total: Math.round(b + movement + workout),
      factor: factor
    };
  }

  /* 由趋势反推的实测缺口（千卡/天） */
  function deficitFromTrend(r) {
    if (r == null) return null;
    return Math.round((-r) * 7700 / 7);
  }

  /* 放纵餐：次数、次日相对趋势线的抬升、回到趋势线所需天数 */
  function cheatStats(daily, series) {
    var emaMap = {};
    series.forEach(function (s) { emaMap[s.date] = s.ema; });
    var list = (daily || []).filter(function (d) { return d && d.cheat && d.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    var today = todayISO();
    var recent = list.filter(function (d) { return diffDays(d.date, today) <= 28; });

    var bumps = [];
    var recovers = [];
    list.forEach(function (d) {
      var next = addDays(d.date, 1);
      var day = null;
      for (var i = 0; i < series.length; i++) if (series[i].date === next) day = series[i];
      if (!day || day.ema == null) return;

      var prevEma = emaMap[d.date];
      if (prevEma != null && day.weight != null) bumps.push(day.weight - prevEma);

      var recovered = null;
      for (var j = 0; j < series.length; j++) {
        if (series[j].date <= d.date) continue;
        if (prevEma != null && series[j].ema != null && series[j].ema <= prevEma) {
          recovered = diffDays(d.date, series[j].date);
          break;
        }
      }
      if (recovered != null) recovers.push(recovered);
    });

    function avg(arr) {
      if (!arr.length) return null;
      return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
    }

    return {
      total: list.length,
      recent: recent.length,
      lastDate: recent.length ? recent[recent.length - 1].date : null,
      avgBump: avg(bumps),
      avgRecover: avg(recovers),
      samples: bumps.length
    };
  }

  /* ---------- 运动折算 ---------- */
  var METS = [
    { key: "walk", label: "快走", met: 4.3 },
    { key: "jog", label: "慢跑", met: 7.0 },
    { key: "run", label: "跑步", met: 9.8 },
    { key: "bike", label: "骑车", met: 7.5 },
    { key: "swim", label: "游泳", met: 8.0 },
    { key: "rope", label: "跳绳", met: 11.0 },
    { key: "strength", label: "力量训练", met: 5.0 },
    { key: "ball", label: "球类", met: 6.5 },
    { key: "yoga", label: "瑜伽", met: 2.5 },
    { key: "stairs", label: "爬楼", met: 8.0 },
    { key: "house", label: "家务", met: 3.3 }
  ];

  function metOf(key) {
    for (var i = 0; i < METS.length; i++) if (METS[i].key === key) return METS[i];
    return METS[0];
  }

  function metLabel(key) { return metOf(key).label; }

  /* MET × 3.5 × 体重 ÷ 200 × 分钟 */
  function workoutKcal(key, minutes, weightKg) {
    var m = metOf(key).met;
    var kg = +weightKg || 70;
    var min = +minutes || 0;
    if (min <= 0) return 0;
    return Math.round(m * 3.5 * kg / 200 * min);
  }

  /* ---------- 身体成分估算 ---------- */
  function bodyComposition(weightKg, profile, waistCm, hipCm) {
    var w = +weightKg, h = +profile.height;
    if (!w || !h) return null;
    var bmi = w / Math.pow(h / 100, 2);
    // Deurenberg：BF% = 1.20×BMI + 0.23×年龄 − 10.8×性别 − 5.4（男=1 女=0）
    var bf = 1.20 * bmi + 0.23 * (+profile.age || 30) - 10.8 * (profile.sex === "female" ? 0 : 1) - 5.4;
    bf = Math.max(3, Math.min(55, bf));
    var lean = w * (1 - bf / 100);
    var whtr = (waistCm && h) ? (+waistCm / h) : null;
    return {
      bmi: Math.round(bmi * 10) / 10,
      bf: Math.round(bf * 10) / 10,
      lean: Math.round(lean * 10) / 10,
      fat: Math.round((w - lean) * 10) / 10,
      whtr: whtr == null ? null : Math.round(whtr * 100) / 100
    };
  }

  /* ---------- 成就 ---------- */
  function achievements(ctx) {
    var series = ctx.series || [];
    var daily = (ctx.daily || []).filter(function (d) { return d && d.weight != null; });
    var st = ctx.stats;
    var prof = ctx.profile || {};
    var list = [];
    var today = todayISO();

    function add(key, name, earned, progress, detail, tone) {
      list.push({
        key: key, name: name,
        earned: !!earned,
        progress: Math.max(0, Math.min(1, progress || 0)),
        detail: detail || "",
        tone: tone || "gold"
      });
    }

    // 首次记录
    add("first", "第一次记录", daily.length > 0, daily.length > 0 ? 1 : 0, daily.length ? "已开始" : "称重一次");

    // 连续记录（允许断一天，用一次"保护"）
    var streak = 0, skipped = 0, started = false;
    var weights = {};
    series.forEach(function (s) { weights[s.date] = s.weight; });
    var cur = today;
    for (var g = 0; g < 400; g++) {
      if (weights[cur] != null) {
        streak++; started = true; skipped = 0;
      } else if (!started) {
        // 今天还没记，不算断
      } else if (skipped === 0) {
        skipped = 1;   // 保护一次
      } else {
        break;
      }
      cur = addDays(cur, -1);
    }
    add("streak7", "连续 7 天", streak >= 7, streak / 7, Math.min(streak, 7) + "/7 天", "blue");
    add("streak30", "连续 30 天", streak >= 30, streak / 30, Math.min(streak, 30) + "/30 天", "blue");

    // 减重里程碑
    var start = +prof.startWeight || (series.length ? series[0].ema : null);
    var lost = (start && st && st.ema) ? start - st.ema : 0;
    add("lose1", "减掉 1 公斤", lost >= 1, lost / 1, fmtKg(lost) + " kg", "green");
    add("lose5", "减掉 5 公斤", lost >= 5, lost / 5, fmtKg(lost) + " kg", "green");
    add("pct5", "减掉 5%", start > 0 && lost / start >= 0.05, start > 0 ? (lost / start) / 0.05 : 0,
      start > 0 ? Math.round(lost / start * 100) + "% / 5%" : "—", "green");
    add("pct10", "减掉 10%", start > 0 && lost / start >= 0.10, start > 0 ? (lost / start) / 0.10 : 0,
      start > 0 ? Math.round(lost / start * 100) + "% / 10%" : "—", "green");

    // 目标
    var target = +prof.targetWeight || 0;
    var done = target > 0 && st && st.ema <= target;
    var tp = (target > 0 && start > target && st && st.ema) ? (start - st.ema) / (start - target) : 0;
    add("goal", "达成目标", done, tp, target > 0 ? Math.round(tp * 100) + "%" : "未设目标", "gold");

    // 本周达标
    var hit = st && st.r != null && st.r <= -MIN_SLOPE;
    add("week", "本周在下降", !!hit, hit ? 1 : 0, st && st.r != null ? fmtKg(st.r) + " kg/周" : "—", "blue");

    // 放纵餐后回到趋势线
    var cs = ctx.cheatStats;
    var back = cs && cs.avgRecover != null && cs.avgRecover <= 2;
    add("cheat", "吃完能收住", !!back, cs && cs.avgRecover != null ? Math.min(1, 2 / cs.avgRecover) : 0,
      cs && cs.avgRecover != null ? "平均 " + fmtKg(cs.avgRecover, 1) + " 天回落" : "还没放纵过", "gold");

    return list;
  }

  /* ---------- 餐次 ---------- */
  var MEALS = [
    { key: "breakfast", label: "早餐" },
    { key: "lunch", label: "午餐" },
    { key: "dinner", label: "晚餐" },
    { key: "snack", label: "加餐" }
  ];
  var MAIN_MEALS = 3;   // 早/午/晚，加餐不计入"是否记全"

  function mealLabel(key) {
    for (var i = 0; i < MEALS.length; i++) if (MEALS[i].key === key) return MEALS[i].label;
    return "其他";
  }

  /* 按时段推断餐次（前端调用，传小时数） */
  function guessMeal(hour) {
    var h = hour == null ? new Date().getHours() : hour;
    if (h < 10) return "breakfast";
    if (h < 15) return "lunch";
    if (h < 21) return "dinner";
    return "snack";
  }

  /* 统一成 meals 数组，兼容旧的 diet/dietKcal 单条字段 */
  function mealsOf(rec) {
    if (!rec) return [];
    if (rec.meals && rec.meals.length) {
      return rec.meals.filter(function (m) { return m && (m.text || m.kcal); });
    }
    if (rec.diet || rec.dietKcal) {
      return [{ slot: "lunch", text: rec.diet || "", kcal: rec.dietKcal == null ? null : +rec.dietKcal }];
    }
    return [];
  }

  /* 饮食汇总：已记几餐、多少千卡、相对全天预算还剩多少 */
  function dietSummary(rec, budget) {
    var meals = mealsOf(rec);
    var kcal = 0, mainSlots = {};
    meals.forEach(function (m) {
      if (m.kcal != null && isFinite(+m.kcal)) kcal += +m.kcal;
      if (m.slot && m.slot !== "snack") mainSlots[m.slot] = 1;
    });
    var recorded = Object.keys(mainSlots).length;
    var b = budget == null ? null : Math.round(budget);
    return {
      meals: meals,
      kcal: Math.round(kcal),
      recorded: recorded,
      total: MAIN_MEALS,
      complete: recorded >= MAIN_MEALS,
      hasSnack: meals.some(function (m) { return m.slot === "snack"; }),
      budget: b,
      remaining: b == null ? null : b - Math.round(kcal),
      over: b != null && kcal > b
    };
  }

  /* ---------- 运动多条 ---------- */
  function workoutsOf(rec) {
    if (!rec) return [];
    if (rec.workouts && rec.workouts.length) {
      return rec.workouts.filter(function (w) { return w && (w.type || w.kcal); });
    }
    if (rec.workout || rec.workoutType) {
      return [{
        type: rec.workoutType || "walk",
        min: rec.workoutMin == null ? null : +rec.workoutMin,
        kcal: rec.workout == null ? null : +rec.workout
      }];
    }
    return [];
  }

  function workoutTotal(rec) {
    var list = workoutsOf(rec);
    var total = 0;
    list.forEach(function (w) { if (w.kcal != null && isFinite(+w.kcal)) total += +w.kcal; });
    return Math.round(total);
  }

  function workoutText(rec) {
    var list = workoutsOf(rec);
    if (!list.length) return "";
    return list.map(function (w) {
      return metLabel(w.type || "walk") + (w.min ? " " + w.min + "min" : "");
    }).join(" + ");
  }

  function fmtKg(v, d) {
    if (v == null || !isFinite(v)) return "—";
    var n = Math.abs(v).toFixed(d == null ? 1 : d);
    return v < 0 ? "-" + n : n;
  }

  /* ---------- 本地饮食估算（未配置 AI 时的兜底） ---------- */
  var FOODS = [
    { k: ["米饭", "白饭", "饭"], n: "米饭", v: 220 },
    { k: ["面条", "拉面", "面"], n: "面食", v: 300 },
    { k: ["馒头", "包子"], n: "面点", v: 220 },
    { k: ["粥"], n: "粥", v: 100 },
    { k: ["鸡蛋", "蛋"], n: "鸡蛋", v: 75 },
    { k: ["牛奶"], n: "牛奶", v: 130 },
    { k: ["豆浆"], n: "豆浆", v: 90 },
    { k: ["油条", "煎饼"], n: "油炸面点", v: 300 },
    { k: ["汉堡", "麦当劳", "肯德基", "kfc"], n: "汉堡", v: 520 },
    { k: ["炸鸡", "薯条"], n: "油炸", v: 450 },
    { k: ["披萨", "匹萨"], n: "披萨", v: 320 },
    { k: ["可乐", "汽水", "饮料"], n: "含糖饮料", v: 140 },
    { k: ["奶茶"], n: "奶茶", v: 360 },
    { k: ["苹果", "香蕉", "水果"], n: "水果", v: 90 },
    { k: ["西瓜"], n: "西瓜", v: 80 },
    { k: ["沙拉"], n: "沙拉", v: 150 },
    { k: ["火锅"], n: "火锅", v: 850 },
    { k: ["烧烤", "烤肉"], n: "烧烤", v: 700 },
    { k: ["麻辣烫", "冒菜"], n: "麻辣烫", v: 500 },
    { k: ["饺子", "馄饨"], n: "饺子", v: 380 },
    { k: ["炒饭", "盖饭"], n: "炒饭", v: 550 },
    { k: ["鸡胸", "鸡胸肉"], n: "鸡胸肉", v: 180 },
    { k: ["酸奶"], n: "酸奶", v: 120 },
    { k: ["饼干", "零食"], n: "零食", v: 200 },
    { k: ["蛋糕", "甜点", "面包"], n: "甜点", v: 340 },
    { k: ["啤酒", "酒"], n: "酒", v: 150 },
    { k: ["咖啡"], n: "咖啡", v: 20 }
  ];

  function localDietParse(text) {
    var s = String(text || "");
    var items = [];
    var used = {};
    var total = 0;
    for (var i = 0; i < FOODS.length; i++) {
      var f = FOODS[i];
      for (var j = 0; j < f.k.length; j++) {
        var key = f.k[j];
        if (s.toLowerCase().indexOf(key) >= 0 && !used[f.n]) {
          used[f.n] = 1;
          items.push({ name: f.n, kcal: f.v });
          total += f.v;
          break;
        }
      }
    }
    if (!total) total = 400; // 无法识别时给一餐的保守估计
    var meals = (s.match(/早|午|晚|夜宵|加餐/g) || []).length;
    if (meals >= 2) total = Math.round(total * (1 + (meals - 1) * 0.45));
    return { kcal: total, items: items.length ? items : [{ name: "一餐（未识别）", kcal: total }], source: "local" };
  }

  /* 本地分析：无 AI 时给出规则结论 */
  function localAnalysis(ctx) {
    var st = ctx.stats;
    var prof = ctx.profile || {};
    var points = [];
    if (!st) return { level: "none", verdict: "数据还不够", points: ["记满 7 天后这里会给出判断"], tip: "" };

    var r = st.r;
    var target = +prof.targetWeight || 0;
    if (r == null) {
      points.push("趋势还没形成，再记几天");
    } else if (r > 0.15) {
      points.push("趋势在回升，近一周涨了 " + Math.abs(r).toFixed(1) + " 公斤");
    } else if (r > -MIN_SLOPE) {
      points.push("趋势基本走平，缺口被日常吃掉了");
    } else {
      points.push("近一周下降 " + Math.abs(r).toFixed(1) + " 公斤，节奏正常");
    }
    if (st.recorded7 < 5) points.push("最近 7 天只记了 " + st.recorded7 + " 天，趋势可信度打折");
    if (st.ema && target && st.ema <= target) points.push("已经到目标体重");
    var level = r == null ? "none" : (r > 0.15 ? "bad" : (r > -MIN_SLOPE ? "warn" : "good"));
    if (st.ema && target && st.ema <= target) level = "good";
    return {
      level: level,
      verdict: level === "good" ? "在按计划走" : (level === "warn" ? "平台期，需要动一动" : (level === "bad" ? "趋势反弹" : "数据不足")),
      points: points,
      tip: ctx.tip || "",
      source: "local"
    };
  }


  /* 每周减重安全上限：不超过 1 公斤，也不超过体重的 1%，下限 0.5 */
  function safeWeeklyLoss(weightKg) {
    var w = +weightKg || 0;
    if (!w) return 1;
    var cap = Math.min(1, Math.max(0.5, w * 0.01));
    return Math.round(cap * 100) / 100;
  }

  /* 对照目标日期需要的每周速度，是否超过安全上限 */
  function planPace(ema, target, targetDate, today) {
    var now = today || todayISO();
    var tgt = +target, cur = +ema;
    if (!isFinite(tgt) || !isFinite(cur) || cur <= tgt) {
      return { ok: true, unsafe: false, needPerWeek: 0, cap: safeWeeklyLoss(cur || tgt), weeksLeft: null, suggestedDate: null };
    }
    var cap = safeWeeklyLoss(cur);
    var daysLeft = targetDate ? diffDays(now, targetDate) : null;
    var weeksLeft = (daysLeft != null && daysLeft > 0) ? daysLeft / 7 : null;
    var needPerWeek = weeksLeft ? (cur - tgt) / weeksLeft : null;
    var unsafe = needPerWeek != null && needPerWeek > cap + 0.02;
    var suggestedDate = null;
    if (unsafe) {
      var weeks = (cur - tgt) / cap;
      suggestedDate = addDays(now, Math.ceil(weeks * 7));
    }
    return {
      ok: true, unsafe: unsafe,
      needPerWeek: needPerWeek, cap: cap,
      weeksLeft: weeksLeft, daysLeft: daysLeft,
      suggestedDate: suggestedDate
    };
  }

  /* 每天一句话 → 尝试拆成三餐（本地规则，AI 失败时用） */
  function localDietSplit(text) {
    var raw = String(text || "").trim();
    if (!raw) return { meals: [], kcal: 0, items: [], source: "local" };
    var parts = [];
    var re = /(早上|早餐|早饭|早|中午|午餐|午饭|午|晚上|晚餐|晚饭|晚|加餐|夜宵|下午茶)/g;
    var marks = [];
    var m;
    while ((m = re.exec(raw))) marks.push({ i: m.index, w: m[0] });
    function slotOf(w) {
      if (/早/.test(w)) return "breakfast";
      if (/午/.test(w) || /下午/.test(w)) return "lunch";
      if (/加餐|夜宵/.test(w)) return "snack";
      if (/晚/.test(w)) return "dinner";
      return "lunch";
    }
    if (marks.length >= 2) {
      for (var i = 0; i < marks.length; i++) {
        var start = marks[i].i;
        var end = i + 1 < marks.length ? marks[i + 1].i : raw.length;
        var chunk = raw.slice(start, end).trim();
        if (chunk) parts.push({ slot: slotOf(marks[i].w), text: chunk });
      }
    } else {
      // 用逗号/分号/句号切开，按出现顺序归到早午晚
      var segs = raw.split(/[，,；;。、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var order = ["breakfast", "lunch", "dinner", "snack"];
      if (segs.length >= 2) {
        segs.forEach(function (seg, i) { parts.push({ slot: order[Math.min(i, 3)], text: seg }); });
      } else {
        parts.push({ slot: guessMeal(new Date(Date.now() + 8 * 3600000).getUTCHours()), text: raw });
      }
    }
    var meals = [];
    var seen = {};
    parts.forEach(function (p) {
      var parsed = localDietParse(p.text);
      var kcal = parsed.kcal;
      if (seen[p.slot]) {
        // 同一餐次合并
        for (var k = 0; k < meals.length; k++) if (meals[k].slot === p.slot) {
          meals[k].text = meals[k].text + "，" + p.text;
          meals[k].kcal = (meals[k].kcal || 0) + kcal;
          meals[k].items = (meals[k].items || []).concat(parsed.items || []);
        }
      } else {
        seen[p.slot] = 1;
        meals.push({ slot: p.slot, text: p.text, kcal: kcal, items: parsed.items || [] });
      }
    });
    var total = meals.reduce(function (a, m) { return a + (m.kcal || 0); }, 0);
    return { meals: meals, kcal: total, items: meals, source: "local" };
  }

  return {
    ALPHA: ALPHA, DECAY: DECAY, MIN_SLOPE: MIN_SLOPE,
    ACTIVITY_LEVELS: ACTIVITY_LEVELS,
    bmr: bmr, expenditure: expenditure, activityFactor: activityFactor,
    activityLabel: activityLabel, deficitFromTrend: deficitFromTrend,
    cheatStats: cheatStats,
    METS: METS, metOf: metOf, metLabel: metLabel, workoutKcal: workoutKcal,
    MEALS: MEALS, MAIN_MEALS: MAIN_MEALS, mealLabel: mealLabel, guessMeal: guessMeal,
    mealsOf: mealsOf, dietSummary: dietSummary,
    workoutsOf: workoutsOf, workoutTotal: workoutTotal, workoutText: workoutText,
    bodyComposition: bodyComposition, achievements: achievements,
    localDietParse: localDietParse, localDietSplit: localDietSplit, localAnalysis: localAnalysis,
    safeWeeklyLoss: safeWeeklyLoss, planPace: planPace,
    toISO: toISO, parseISO: parseISO, addDays: addDays, diffDays: diffDays,
    todayISO: todayISO, buildSeries: buildSeries, stats: stats,
    predict: predict, confidence: confidence, calibration: calibration,
    formatDate: formatDate, formatWeekday: formatWeekday, emaOn: emaOn
  };
});
