/* 壮尼Ni · 老粉丝互动粉丝箱
   自写的轻量 2D 圆形物理：重力、墙壁/地面反弹、球与球碰撞、摩擦与滚动。
   粉丝数据取自页面里的 .fan-card（飞书同步后会重新读取），原卡片保留为无 JS / 减少动效时的备用内容。 */
(function () {
  "use strict";

  var section = document.getElementById("old-fans");
  if (!section) return;
  var boxEl = section.querySelector("[data-fan-box]");
  var list = section.querySelector(".fan-timeline");
  if (!boxEl || !list) return;
  var stage = boxEl.querySelector(".fan-box-stage");
  var canvas = boxEl.querySelector(".fan-box-canvas");
  var tip = boxEl.querySelector(".fan-box-tip");
  var countEl = boxEl.querySelector(".fan-box-count");
  var replayBtn = boxEl.querySelector(".fan-box-replay");
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  var mqReduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  /* ---------- 参数 ---------- */
  var STEP = 1 / 120;
  var GRAVITY = 2000;
  var WALL_PAD = 6;
  var FLOOR_PAD = 14;
  var E_WALL = 0.5;
  var E_BALL = 0.62;
  var MU_WALL = 0.45;
  var MU_BALL = 0.12;
  var MAX_V = 2600;
  var DROP_GAP = 0.48; // 秒，依次投入的间隔
  var POINTER_R = 14;

  /* ---------- 状态 ---------- */
  var W = 0, H = 0, dpr = 1;
  var fans = [];
  var balls = [];
  var queue = []; // 等待投入的粉丝
  var simTime = 0, nextDropAt = 0;
  var active = false, visible = false, dropped = false;
  var raf = 0, lastTs = 0, acc = 0, idle = 0;
  var colors = {};
  var imgCache = {};

  var pointer = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, t: 0, inside: false, type: "mouse" };
  var press = null;   // { ball, x, y, t, id, type }
  var drag = null;    // { ball, id, tx, ty }
  var hoverBall = null, hoverUntil = 0, tapBall = null, tapUntil = 0, tipBall = null;

  /* ---------- 读取粉丝 ---------- */
  function txt(el) { return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  function readFans() {
    var cards = Array.prototype.slice.call(list.querySelectorAll(".fan-card"));
    var out = cards.map(function (card, i) {
      var img = card.querySelector(".fan-avatar img");
      var time = card.querySelector("time");
      var name = txt(card.querySelector(".fan-name"));
      var badge = txt(card.querySelector(".fan-badge"));
      return {
        idx: i,
        name: name,
        badge: badge,
        tag: txt(card.querySelector(".fan-tag")),
        when: txt(card.querySelector(".fan-when")),
        date: time ? time.getAttribute("datetime") || "" : "",
        src: img ? img.getAttribute("src") || "" : "",
        initial: Array.from(name || "粉")[0],
        big: /初代/.test(badge)
      };
    }).filter(function (f) { return f.name; });
    // 按关注时间先后投入，早关注的先进箱子
    out.sort(function (a, b) {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.idx - b.idx;
    });
    return out;
  }

  function loadImg(src) {
    if (!src) return null;
    if (imgCache[src]) return imgCache[src];
    var im = new Image();
    im.decoding = "async";
    im.onload = function () { im._ok = true; drawOnce(); };
    im.onerror = function () { im._bad = true; };
    im.src = src;
    imgCache[src] = im;
    return im;
  }

  /* ---------- 尺寸与主题 ---------- */
  function readColors() {
    var cs = getComputedStyle(stage);
    function v(n, d) { return (cs.getPropertyValue(n) || "").trim() || d; }
    colors = {
      ringA: v("--gold-hover", "#f0d58a"),
      ringB: v("--gold-deep", "#c9a24a"),
      fill: v("--gold-fill", "#e8c878"),
      ink: v("--gold-ink", "#1a1406"),
      glow: v("--gold-fill", "#e8c878"),
      light: document.documentElement.getAttribute("data-theme") === "light"
    };
  }

  function baseRadius() {
    var r = Math.max(30, Math.min(64, W * 0.068));
    // 粉丝多时自动缩小，保证箱子装得下
    var area = 0;
    fans.forEach(function (f) { var k = f.big ? 1.2 : 1; area += Math.PI * r * r * k * k; });
    var cap = W * H * 0.34;
    if (area > cap) r *= Math.sqrt(cap / area);
    return Math.max(12, r);
  }

  function resize() {
    var rect = stage.getBoundingClientRect();
    var nw = Math.max(1, Math.round(rect.width)), nh = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(nw * dpr);
    canvas.height = Math.round(nh * dpr);
    if (W && H && balls.length) {
      var sx = nw / W, sy = nh / H;
      balls.forEach(function (b) { b.x *= sx; b.y *= sy; });
    }
    W = nw; H = nh;
    var r0 = baseRadius();
    balls.forEach(function (b) { setRadius(b, r0 * (b.fan.big ? 1.2 : 1)); });
    wake();
    drawOnce();
  }

  function setRadius(b, r) {
    b.r = r;
    b.m = r * r;
    b.I = 0.4 * b.m * r * r;
  }

  /* ---------- 球 ---------- */
  function spawn(fan) {
    var r0 = baseRadius() * (fan.big ? 1.2 : 1);
    var b = {
      fan: fan,
      img: loadImg(fan.src),
      x: W / 2 + (Math.random() - 0.5) * Math.min(60, W * 0.08),
      y: -r0 - 4,
      vx: (Math.random() - 0.5) * 360,
      vy: 260,
      a: (Math.random() - 0.5) * 0.6,
      w: (Math.random() - 0.5) * 6,
      entered: false,
      born: simTime
    };
    setRadius(b, r0);
    balls.push(b);
  }

  function startDrop() {
    balls = [];
    queue = fans.slice();
    nextDropAt = simTime + 0.15;
    dropped = true;
    hideTip();
    wake();
  }

  /* ---------- 物理 ---------- */
  function invM(b) { return drag && drag.ball === b ? 0 : 1 / b.m; }
  function invI(b) { return drag && drag.ball === b ? 0 : 1 / b.I; }

  // 球与静止平面（墙/地/顶）接触，n 指向箱内
  function wallContact(b, nx, ny, pen) {
    b.x += nx * pen; b.y += ny * pen;
    var vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    var e = vn > -60 ? 0 : E_WALL;
    var jn = -(1 + e) * vn * b.m;
    b.vx += nx * jn / b.m; b.vy += ny * jn / b.m;
    // 摩擦：接触点相对速度的切向分量 → 带动转动，形成滚动
    var rcx = -nx * b.r, rcy = -ny * b.r;
    var tx = -ny, ty = nx;
    var vcx = b.vx - b.w * rcy, vcy = b.vy + b.w * rcx;
    var vt = vcx * tx + vcy * ty;
    var rct = rcx * ty - rcy * tx;
    var k = 1 / b.m + rct * rct / b.I;
    var jt = -vt / k, lim = MU_WALL * jn;
    if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
    b.vx += tx * jt / b.m; b.vy += ty * jt / b.m;
    b.w += rct * jt / b.I;
  }

  function ballContact(A, B) {
    var dx = B.x - A.x, dy = B.y - A.y;
    var rs = A.r + B.r;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = Math.sqrt(d2) || 0.0001;
    var nx = dx / d, ny = dy / d;
    var ia = invM(A), ib = invM(B);
    if (ia + ib === 0) return;
    var pen = rs - d;
    A.x -= nx * pen * ia / (ia + ib); A.y -= ny * pen * ia / (ia + ib);
    B.x += nx * pen * ib / (ia + ib); B.y += ny * pen * ib / (ia + ib);
    var rax = nx * A.r, ray = ny * A.r, rbx = -nx * B.r, rby = -ny * B.r;
    var vax = A.vx - A.w * ray, vay = A.vy + A.w * rax;
    var vbx = B.vx - B.w * rby, vby = B.vy + B.w * rbx;
    var rvx = vbx - vax, rvy = vby - vay;
    var vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    var e = vn > -60 ? 0 : E_BALL;
    var jn = -(1 + e) * vn / (ia + ib);
    A.vx -= nx * jn * ia; A.vy -= ny * jn * ia;
    B.vx += nx * jn * ib; B.vy += ny * jn * ib;
    var tx = -ny, ty = nx;
    var vt = rvx * tx + rvy * ty;
    var rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
    var iia = invI(A), iib = invI(B);
    var k = ia + ib + rat * rat * iia + rbt * rbt * iib;
    var jt = -vt / k, lim = MU_BALL * jn;
    if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
    A.vx -= tx * jt * ia; A.vy -= ty * jt * ia; A.w -= rat * jt * iia;
    B.vx += tx * jt * ib; B.vy += ty * jt * ib; B.w += rbt * jt * iib;
  }

  function step(dt) {
    simTime += dt;
    if (queue.length && simTime >= nextDropAt) {
      spawn(queue.shift());
      nextDropAt = simTime + DROP_GAP;
    }
    var floor = H - FLOOR_PAD;
    var i, j, b;
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      if (drag && drag.ball === b) {
        // 拖拽：用弹簧把球拉向手指/鼠标
        var tvx = (drag.tx - b.x) * 22, tvy = (drag.ty - b.y) * 22;
        b.vx += (tvx - b.vx) * 0.5; b.vy += (tvy - b.vy) * 0.5;
        b.w *= 0.96;
      } else {
        b.vy += GRAVITY * dt;
        var damp = Math.exp(-0.18 * dt);
        b.vx *= damp; b.vy *= damp;
        b.w *= Math.exp(-0.35 * dt);
      }
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > MAX_V) { b.vx *= MAX_V / sp; b.vy *= MAX_V / sp; }
      if (b.w > 40) b.w = 40; else if (b.w < -40) b.w = -40;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.a += b.w * dt;
      if (!b.entered && b.y - b.r > 2) b.entered = true;
    }
    for (var it = 0; it < 3; it++) {
      for (i = 0; i < balls.length; i++) {
        for (j = i + 1; j < balls.length; j++) ballContact(balls[i], balls[j]);
      }
      for (i = 0; i < balls.length; i++) {
        b = balls[i];
        if (b.x - b.r < WALL_PAD) wallContact(b, 1, 0, WALL_PAD - (b.x - b.r));
        if (b.x + b.r > W - WALL_PAD) wallContact(b, -1, 0, b.x + b.r - (W - WALL_PAD));
        if (b.y + b.r > floor) wallContact(b, 0, -1, b.y + b.r - floor);
        if (b.entered && b.y - b.r < 0) wallContact(b, 0, 1, -(b.y - b.r));
      }
    }
    // 地面滚动阻力，让球慢慢停下
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      if (b.y + b.r > floor - 1.5) {
        b.w *= Math.exp(-1.1 * dt);
        b.vx *= Math.exp(-0.9 * dt);
        if (Math.abs(b.vx) < 3 && Math.abs(b.vy) < 25) { b.vx = 0; b.w *= 0.9; }
        // 静止后慢慢把头像转正，看得清是谁
        if (Math.abs(b.vx) < 6 && Math.abs(b.w) < 0.6 && !(drag && drag.ball === b)) {
          var up = Math.round(b.a / (Math.PI * 2)) * Math.PI * 2;
          b.a += (up - b.a) * (1 - Math.exp(-2.2 * dt));
          if (Math.abs(up - b.a) < 0.002) b.a = up;
        }
      }
    }
  }

  function energy() {
    var e = 0;
    balls.forEach(function (b) {
      var off = Math.abs(b.a - Math.round(b.a / (Math.PI * 2)) * Math.PI * 2) * b.r;
      e = Math.max(e, Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.w) * b.r + off * 4);
    });
    return e;
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var floor = H - FLOOR_PAD;
    var i, b;
    // 地面投影
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      var gap = Math.max(0, floor - (b.y + b.r));
      var k = 1 - Math.min(1, gap / (H * 0.8));
      if (k <= 0.02) continue;
      var sw = b.r * (0.55 + 0.45 * k);
      var g = ctx.createRadialGradient(b.x, floor, 0, b.x, floor, sw);
      var alpha = (colors.light ? 0.26 : 0.5) * k;
      g.addColorStop(0, "rgba(" + (colors.light ? "70,48,10," : "0,0,0,") + alpha + ")");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.translate(b.x, floor);
      ctx.scale(1, 0.22);
      ctx.translate(-b.x, -floor);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, floor, sw, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (i = 0; i < balls.length; i++) drawBall(balls[i]);
  }

  function drawBall(b) {
    var r = b.r, ring = Math.max(2, r * 0.05);
    var hot = b === tipBall || (drag && drag.ball === b);
    ctx.save();
    // 外圈：金色细环（初代粉丝带金色光晕）
    if (b.fan.big || hot) {
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = b.fan.big ? (hot ? 34 : 24) : 16;
    }
    var rg = ctx.createLinearGradient(b.x - r, b.y - r, b.x + r, b.y + r);
    rg.addColorStop(0, colors.ringA);
    rg.addColorStop(1, colors.ringB);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    // 头像
    ctx.beginPath();
    ctx.arc(b.x, b.y, r - ring, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.a);
    var ir = r - ring;
    if (b.img && b.img._ok && b.img.naturalWidth) {
      var iw = b.img.naturalWidth, ih = b.img.naturalHeight, s = Math.min(iw, ih);
      ctx.drawImage(b.img, (iw - s) / 2, (ih - s) / 2, s, s, -ir, -ir, ir * 2, ir * 2);
    } else {
      var fg = ctx.createLinearGradient(-ir, -ir, ir, ir);
      fg.addColorStop(0, colors.ringA); fg.addColorStop(1, colors.fill);
      ctx.fillStyle = fg;
      ctx.fillRect(-ir, -ir, ir * 2, ir * 2);
      ctx.fillStyle = colors.ink;
      ctx.font = "700 " + Math.round(ir * 0.9) + "px " + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.fan.initial, 0, ir * 0.04);
    }
    ctx.rotate(-b.a);
    // 玻璃球质感：固定光源的高光与暗部
    var hl = ctx.createRadialGradient(-ir * 0.38, -ir * 0.45, 0, -ir * 0.2, -ir * 0.25, ir * 1.15);
    hl.addColorStop(0, "rgba(255,255,255,0.38)");
    hl.addColorStop(0.35, "rgba(255,255,255,0.06)");
    hl.addColorStop(0.75, "rgba(0,0,0,0.04)");
    hl.addColorStop(1, "rgba(0,0,0,0.30)");
    ctx.fillStyle = hl;
    ctx.fillRect(-ir, -ir, ir * 2, ir * 2);
    ctx.restore();
    // 内侧细描边
    ctx.beginPath();
    ctx.arc(b.x, b.y, r - ring, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* ---------- 提示气泡 ---------- */
  function setTip(b) {
    if (tipBall === b) return;
    tipBall = b;
    if (!b) { tip.classList.remove("is-on"); return; }
    var f = b.fan;
    tip.replaceChildren();
    var row = document.createElement("div");
    row.className = "tip-row";
    var n = document.createElement("span");
    n.className = "tip-name";
    n.textContent = f.name;
    row.appendChild(n);
    if (f.badge) { var bd = document.createElement("span"); bd.className = "fan-badge"; bd.textContent = f.badge; row.appendChild(bd); }
    if (f.tag) { var tg = document.createElement("span"); tg.className = "fan-tag"; tg.textContent = f.tag; row.appendChild(tg); }
    tip.appendChild(row);
    if (f.when) { var w = document.createElement("div"); w.className = "tip-when"; w.textContent = f.when; tip.appendChild(w); }
    tip._w = tip.offsetWidth; tip._h = tip.offsetHeight;
    placeTip();
    tip.classList.add("is-on");
  }

  function placeTip() {
    var b = tipBall;
    if (!b) return;
    var tw = tip._w || 140, th = tip._h || 56;
    var x = Math.max(tw / 2 + 8, Math.min(W - tw / 2 - 8, b.x));
    var below = b.y - b.r - 14 < th + 6;
    var y = below ? b.y + b.r + 14 : b.y - b.r - 12;
    tip.classList.toggle("is-below", below);
    tip.style.left = x.toFixed(1) + "px";
    tip.style.top = y.toFixed(1) + "px";
    tip.style.setProperty("--ax", Math.max(14, Math.min(tw - 14, tw / 2 + (b.x - x))).toFixed(1) + "px");
  }

  function hideTip() { hoverBall = null; tapBall = null; setTip(null); }

  function updateTip(now) {
    var want = null;
    if (drag) want = drag.ball;
    else if (tapBall && now < tapUntil) want = tapBall;
    else if (hoverBall && now < hoverUntil) want = hoverBall;
    if (want && balls.indexOf(want) < 0) want = null;
    setTip(want);
    if (want) placeTip();
  }

  /* ---------- 循环 ---------- */
  function frame(ts) {
    raf = 0;
    if (!active || !visible || document.hidden) return;
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : STEP;
    lastTs = ts;
    acc += dt;
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    draw();
    updateTip(performance.now());
    // 全部静止一会儿后暂停，省电；有互动时再唤醒
    if (!queue.length && !drag && energy() < 6) idle += dt; else idle = 0;
    if (idle > 1.5 && !tipBall) { draw(); return; }
    raf = requestAnimationFrame(frame);
  }

  function wake() {
    idle = 0;
    if (!raf && active && visible && !document.hidden) {
      lastTs = 0; acc = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function drawOnce() { if (active && W) { draw(); placeTip(); } }

  /* ---------- 交互 ---------- */
  function local(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hit(x, y, extra) {
    var best = null, bd = Infinity;
    for (var i = balls.length - 1; i >= 0; i--) {
      var b = balls[i], dx = x - b.x, dy = y - b.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < b.r + (extra || 0) && d < bd) { best = b; bd = d; }
    }
    return best;
  }

  function trackPointer(p, now) {
    var dt = Math.max(0.004, (now - (pointer.t || now)) / 1000);
    var ivx = (p.x - pointer.x) / dt, ivy = (p.y - pointer.y) / dt;
    if (!pointer.t || now - pointer.t > 120) { ivx = 0; ivy = 0; }
    pointer.vx = pointer.vx * 0.4 + ivx * 0.6;
    pointer.vy = pointer.vy * 0.4 + ivy * 0.6;
    var sp = Math.sqrt(pointer.vx * pointer.vx + pointer.vy * pointer.vy);
    if (sp > 3200) { pointer.vx *= 3200 / sp; pointer.vy *= 3200 / sp; }
    pointer.px = pointer.x; pointer.py = pointer.y;
    pointer.x = p.x; pointer.y = p.y; pointer.t = now;
  }

  // 鼠标划过时按“扫过的线段”推球，快速晃动也不会穿过去
  function pushBalls() {
    var ax = pointer.px, ay = pointer.py, bx = pointer.x, by = pointer.y;
    var sx = bx - ax, sy = by - ay, sl = sx * sx + sy * sy;
    var touched = false;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (press && press.ball === b) continue;
      if (drag && drag.ball === b) continue;
      var t = sl ? Math.max(0, Math.min(1, ((b.x - ax) * sx + (b.y - ay) * sy) / sl)) : 1;
      var cx = ax + sx * t, cy = ay + sy * t;
      var dx = b.x - cx, dy = b.y - cy, d = Math.sqrt(dx * dx + dy * dy);
      var rs = b.r + POINTER_R;
      if (d >= rs) continue;
      if (d < 0.001) { dx = 0; dy = -1; d = 1; }
      var nx = dx / d, ny = dy / d;
      var vn = (b.vx - pointer.vx) * nx + (b.vy - pointer.vy) * ny;
      if (vn < 0) {
        b.vx -= nx * vn * 1.35;
        b.vy -= ny * vn * 1.35;
        var tv = pointer.vx * -ny + pointer.vy * nx;
        b.w += (tv / b.r) * 0.25;
      }
      b.x += nx * (rs - d) * 0.6;
      b.y += ny * (rs - d) * 0.6;
      touched = true;
    }
    if (touched) wake();
  }

  function kick(b) {
    b.vy = -(900 + Math.random() * 420) * Math.sqrt(48 / Math.max(24, b.r));
    b.vx += (Math.random() - 0.5) * 520;
    b.w += (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 10);
    wake();
  }

  function onDown(e) {
    if (!active) return;
    var p = local(e), now = performance.now();
    pointer.type = e.pointerType || "mouse";
    pointer.x = pointer.px = p.x; pointer.y = pointer.py = p.y; pointer.t = now; pointer.vx = pointer.vy = 0;
    var b = hit(p.x, p.y, e.pointerType === "touch" ? 8 : 0);
    if (!b) return;
    press = { ball: b, x: p.x, y: p.y, t: now, id: e.pointerId, type: pointer.type };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (e.pointerType !== "touch") e.preventDefault();
  }

  function onMove(e) {
    if (!active) return;
    var p = local(e), now = performance.now();
    pointer.inside = true;
    trackPointer(p, now);
    if (press && press.id === e.pointerId && !drag) {
      if (Math.abs(p.x - press.x) + Math.abs(p.y - press.y) > 6) {
        drag = { ball: press.ball, id: e.pointerId, tx: p.x, ty: p.y };
        canvas.classList.add("is-drag");
        wake();
      }
    }
    if (drag && drag.id === e.pointerId) {
      drag.tx = Math.max(drag.ball.r, Math.min(W - drag.ball.r, p.x));
      drag.ty = Math.max(drag.ball.r, Math.min(H - FLOOR_PAD - drag.ball.r, p.y));
      wake();
      return;
    }
    if (e.pointerType !== "touch") {
      pushBalls();
      var hb = hit(p.x, p.y, 26);
      if (hb) { hoverBall = hb; hoverUntil = now + 900; wake(); }
      canvas.classList.toggle("is-hover", !!hit(p.x, p.y, 0));
    }
  }

  function onUp(e) {
    if (!press || press.id !== e.pointerId) return;
    var now = performance.now();
    if (drag) {
      var b = drag.ball;
      var fresh = now - pointer.t < 80;
      b.vx = fresh ? pointer.vx : b.vx * 0.3;
      b.vy = fresh ? pointer.vy : b.vy * 0.3;
      b.w += (b.vx / b.r) * 0.3;
      drag = null;
      canvas.classList.remove("is-drag");
    } else if (now - press.t < 500) {
      kick(press.ball);
      if (press.type === "touch") { tapBall = press.ball; tapUntil = now + 2400; }
      else { hoverBall = press.ball; hoverUntil = now + 1400; }
    }
    press = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    wake();
  }

  function onCancel(e) {
    if (press && press.id === e.pointerId) press = null;
    if (drag && drag.id === e.pointerId) { drag = null; canvas.classList.remove("is-drag"); }
    wake();
  }

  function onLeave() {
    pointer.inside = false;
    pointer.t = 0;
    canvas.classList.remove("is-hover");
  }

  // 触屏：只有按在球上才阻止页面滚动，其余地方照常上下滑
  function onTouchStart(e) {
    if (!active || !e.touches || e.touches.length !== 1) return;
    var t = e.touches[0], rect = canvas.getBoundingClientRect();
    if (hit(t.clientX - rect.left, t.clientY - rect.top, 8)) e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  replayBtn.addEventListener("click", function () { startDrop(); });

  /* ---------- 生命周期 ---------- */
  function setCount() {
    countEl.replaceChildren();
    var bnum = document.createElement("b");
    bnum.textContent = String(fans.length);
    countEl.appendChild(bnum);
    countEl.appendChild(document.createTextNode(" 位老粉丝已投进箱子"));
  }

  function activate() {
    var reduce = mqReduce && mqReduce.matches;
    fans = readFans();
    if (reduce || !fans.length) {
      active = false;
      section.classList.remove("fanbox-on");
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      return;
    }
    var wasActive = active && W > 0;
    active = true;
    section.classList.add("fanbox-on");
    readColors();
    setCount();
    if (wasActive && dropped) {
      // 飞书数据到达后：已在箱子里的粉丝原地保留，只补投新增的，去掉已删除的
      var keyOf = function (f) { return f.name + "|" + f.src; };
      var byKey = {};
      fans.forEach(function (f) { byKey[keyOf(f)] = f; });
      balls = balls.filter(function (b) {
        var f = byKey[keyOf(b.fan)];
        if (f) { b.fan = f; return true; }
        return false;
      });
      var have = {};
      balls.forEach(function (b) { have[keyOf(b.fan)] = 1; });
      queue = fans.filter(function (f) { return !have[keyOf(f)] && !queue.some(function (q) { return keyOf(q) === keyOf(f); }); })
        .concat(queue.filter(function (q) { return byKey[keyOf(q)]; }));
      queue.sort(function (a, b) { return fans.indexOf(a) - fans.indexOf(b); });
      if (drag && balls.indexOf(drag.ball) < 0) drag = null;
      if (press && balls.indexOf(press.ball) < 0) press = null;
      if (tipBall && balls.indexOf(tipBall) < 0) hideTip();
      var r0 = baseRadius();
      balls.forEach(function (b) { setRadius(b, r0 * (b.fan.big ? 1.2 : 1)); b.img = loadImg(b.fan.src); });
      if (queue.length && nextDropAt < simTime) nextDropAt = simTime + 0.1;
      wake();
      drawOnce();
      return;
    }
    W = 0; H = 0;
    balls = []; queue = [];
    resize();
    dropped = false;
    if (visible) startDrop();
  }

  var refreshTimer = 0;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(activate, 40);
  }
  window.ZN_refreshFanBox = refresh;
  if (window.ZN_FANBOX_DEBUG) {
    window.__fbDebug = function () { return balls.map(function (b) { return { x: b.x, y: b.y, r: b.r, name: b.fan.name }; }); };
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        visible = en.isIntersecting;
        if (visible && active && !dropped) startDrop();
        if (visible) wake();
      });
    }, { threshold: 0.3 }).observe(stage);
  } else {
    visible = true;
  }

  document.addEventListener("visibilitychange", function () { if (!document.hidden) wake(); });
  if ("ResizeObserver" in window) {
    var lastW = 0, lastH = 0;
    new ResizeObserver(function () {
      if (!active) return;
      var r = stage.getBoundingClientRect();
      if (Math.round(r.width) === lastW && Math.round(r.height) === lastH) return;
      lastW = Math.round(r.width); lastH = Math.round(r.height);
      resize();
    }).observe(stage);
  } else {
    window.addEventListener("resize", function () { if (active) resize(); });
  }
  new MutationObserver(function () {
    if (!active) return;
    readColors();
    drawOnce();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  // 飞书同步替换卡片后自动重建
  new MutationObserver(refresh).observe(list, { childList: true });
  if (mqReduce) {
    if (mqReduce.addEventListener) mqReduce.addEventListener("change", activate);
    else if (mqReduce.addListener) mqReduce.addListener(activate);
  }

  activate();
  if (!visible && !("IntersectionObserver" in window) && active) startDrop();
})();
