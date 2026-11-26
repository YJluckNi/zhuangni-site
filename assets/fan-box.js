/* 壮尼Ni · 老粉丝互动粉丝箱
   自写的轻量 2D 圆形物理：重力、墙壁/地面反弹、球与球碰撞、摩擦与滚动。
   人多时分三层：球径与箱高随人数变化 → 只有最早一批是头像球、其余是小彩珠 → 同屏上限并分批「换一批」。
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
  var findForm = boxEl.querySelector("[data-fan-box-find]");
  var findInput = findForm && findForm.querySelector("input");
  var batchBtn = boxEl.querySelector(".fan-box-batch");
  var batchIdxEl = boxEl.querySelector(".fan-box-batch-idx");
  var findMsg = boxEl.querySelector(".fan-box-find-msg");
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  var mqReduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var mqNarrow = window.matchMedia ? window.matchMedia("(max-width: 860px)") : null;

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
  var POINTER_R = 14;
  var BEAD_PALETTE = [
    ["#f0d58a", "#c9a24a"],
    ["#e0b07a", "#a56b32"],
    ["#d9c4a8", "#8a7358"],
    ["#d48a7a", "#8d4a40"],
    ["#8eb3ae", "#3f615e"],
    ["#97a97c", "#4d5c3a"],
    ["#7e8eaa", "#3c4860"],
    ["#c9a3be", "#73506c"],
    ["#dcc07a", "#8a7024"],
    ["#b48a68", "#6a4c34"]
  ];

  /* ---------- 状态 ---------- */
  var W = 0, H = 0, dpr = 1;
  var allFans = [];
  var fans = [];       // 当前这一批
  var batches = [];
  var batchIndex = 0, batchCount = 1;
  var balls = [];
  var queue = [];
  var simTime = 0, nextDropAt = 0;
  var active = false, visible = false, dropped = false;
  var raf = 0, lastTs = 0, acc = 0, idle = 0;
  var colors = {};
  var imgCache = {};
  var bodyFont = "sans-serif";
  var overrideFans = null;
  var perfScale = 1;
  var fpsEma = 60;
  var fpsLowStreak = 0;
  var lastAdaptAt = -99;
  var pouring = false, pourDone = null, pourTimer = 0;
  var foundBall = null, foundUntil = 0;
  var findMsgTimer = 0;

  var pointer = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, t: 0, inside: false, type: "mouse" };
  var press = null;
  var drag = null;
  var hoverBall = null, hoverUntil = 0, tapBall = null, tapUntil = 0, tipBall = null;

  /* ---------- 读取粉丝 ---------- */
  function txt(el) { return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  function paletteOf(f) {
    var s = String(f.name || "") + "|" + String(f.ord);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return BEAD_PALETTE[(h >>> 0) % BEAD_PALETTE.length];
  }

  function decorate(list) {
    list.forEach(function (f, i) {
      f.ord = i;
      f.initial = Array.from(f.name || "粉")[0];
      f.big = !!f.big || /初代/.test(f.badge || "");
      f.pal = paletteOf(f);
    });
    return list;
  }

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
        big: /初代/.test(badge)
      };
    }).filter(function (f) { return f.name; });
    out.sort(function (a, b) {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.idx - b.idx;
    });
    return decorate(out);
  }

  function currentList() {
    return overrideFans ? overrideFans.slice() : readFans();
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

  function fanKey(f) {
    return (f.name || "") + "|" + (f.date || "") + "|" + (f.src || "");
  }

  /* ---------- 容量、箱高、分批 ---------- */
  function isNarrow() {
    if (mqNarrow && mqNarrow.matches) return true;
    if (W && W < 700) return true;
    return window.innerWidth <= 860;
  }

  function computeCaps() {
    var narrow = isNarrow();
    var avatar = narrow ? 30 : 50;
    var screen = narrow ? 50 : 80;
    screen = Math.max(narrow ? 20 : 24, Math.round(screen * perfScale));
    if (avatar > screen) avatar = screen;
    return {
      avatarCap: avatar,
      screenCap: screen,
      minAvatarR: narrow ? 18 : 22,
      beadR: narrow ? 7 : 9
    };
  }

  function desiredHeight() {
    var narrow = isNarrow();
    var n = Math.min(computeCaps().screenCap, Math.max(allFans.length, fans.length, 1));
    var minH = narrow ? 300 : 320;
    var maxH = Math.round(Math.min(window.innerHeight * 0.6, narrow ? 560 : 720));
    if (maxH < minH) maxH = minH;
    var t = (n - 4) / 36;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    t = t * t * (3 - 2 * t);
    return Math.round(minH + (maxH - minH) * t);
  }

  function applyHeight() {
    var h = desiredHeight();
    var prev = parseFloat(stage.style.getPropertyValue("--fanbox-h")) || 0;
    if (Math.abs(prev - h) < 2) return false;
    stage.style.setProperty("--fanbox-h", h + "px");
    return true;
  }

  function isAvatarFan(f) {
    if (!f) return false;
    if (f.big) return true;
    return (f.ord | 0) < computeCaps().avatarCap;
  }

  function rebuildBatches() {
    var cap = computeCaps().screenCap;
    var n = allFans.length;
    batches = [];
    if (n <= cap) {
      batches.push(allFans.slice());
    } else {
      for (var i = 0; i < n; i += cap) batches.push(allFans.slice(i, i + cap));
    }
    batchCount = Math.max(1, batches.length);
    if (batchIndex >= batchCount) batchIndex = 0;
    fans = batches[batchIndex] ? batches[batchIndex].slice() : [];
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
    try { bodyFont = getComputedStyle(document.body).fontFamily || bodyFont; } catch (e) { /* 忽略 */ }
  }

  function radii() {
    var caps = computeCaps();
    var avatars = 0, beads = 0;
    var source = fans.length ? fans : balls.map(function (b) { return b.fan; });
    source.forEach(function (f) { if (isAvatarFan(f)) avatars++; else beads++; });
    var r = Math.min(64, Math.max(caps.minAvatarR, W * 0.068));
    var beadR = caps.beadR;
    if (beads > 40) beadR = Math.max(6, beadR - 1);
    var capArea = Math.max(1, W * H * 0.34);
    var beadArea = beads * Math.PI * beadR * beadR;
    var leftover = Math.max(capArea * 0.18, capArea - beadArea);
    var area = avatars * Math.PI * r * r * 1.08;
    if (area > leftover && leftover > 0 && avatars) r *= Math.sqrt(leftover / area);
    r = Math.max(caps.minAvatarR, r);
    return { avatar: r, bead: beadR };
  }

  function resize() {
    var rect = stage.getBoundingClientRect();
    var nw = Math.max(1, Math.round(rect.width)), nh = Math.max(1, Math.round(rect.height));
    var many = balls.length + queue.length > 40;
    dpr = Math.min(window.devicePixelRatio || 1, many ? 1.75 : 2.5);
    canvas.width = Math.round(nw * dpr);
    canvas.height = Math.round(nh * dpr);
    if (W && balls.length) {
      if (W !== nw) {
        var sx = nw / W;
        balls.forEach(function (b) { b.x *= sx; });
      }
      if (H !== nh) {
        var floorOld = H - FLOOR_PAD, floorNew = nh - FLOOR_PAD;
        balls.forEach(function (b) { b.y = floorNew - (floorOld - b.y); });
      }
    }
    W = nw; H = nh;
    applyRadii();
    wake();
    drawOnce();
  }

  function setRadius(b, r) {
    b.r = r;
    b.m = r * r;
    b.I = 0.4 * b.m * r * r;
  }

  function radiusFor(fan, rs) {
    rs = rs || radii();
    if (!isAvatarFan(fan)) return rs.bead;
    return rs.avatar * (fan.big ? 1.2 : 1);
  }

  function applyRadii() {
    var rs = radii();
    balls.forEach(function (b) { setRadius(b, radiusFor(b.fan, rs)); });
  }

  /* ---------- 球 ---------- */
  function spawn(fan) {
    var rs = radii();
    var kind = isAvatarFan(fan) ? "avatar" : "bead";
    var r0 = radiusFor(fan, rs);
    var spread = Math.min(W * 0.22, kind === "bead" ? 70 : 48);
    var b = {
      fan: fan,
      kind: kind,
      img: kind === "avatar" ? loadImg(fan.src) : null,
      x: W / 2 + (Math.random() - 0.5) * spread,
      y: -r0 - 4,
      vx: (Math.random() - 0.5) * 360,
      vy: 260,
      a: (Math.random() - 0.5) * 0.6,
      w: (Math.random() - 0.5) * 6,
      entered: false,
      exiting: false,
      born: simTime
    };
    setRadius(b, r0);
    balls.push(b);
    return b;
  }

  function dropGap() {
    var n = fans.length;
    if (n <= 8) return 0.48;
    if (n <= 20) return 0.18;
    if (n <= 50) return 0.08;
    return 0.045;
  }

  function startDrop() {
    balls = [];
    queue = fans.slice();
    nextDropAt = simTime + 0.12;
    dropped = true;
    pouring = false;
    foundBall = null;
    hideTip();
    wake();
  }

  function startPour(done) {
    pouring = true;
    hideTip();
    foundBall = null;
    drag = null;
    press = null;
    queue = [];
    balls.forEach(function (b) {
      b.entered = false;
      b.exiting = true;
      b.vy = -(820 + Math.random() * 640);
      b.vx += (Math.random() - 0.5) * 260;
      b.w += (Math.random() - 0.5) * 10;
    });
    pourDone = done;
    clearTimeout(pourTimer);
    pourTimer = setTimeout(function () {
      if (!pouring) return;
      balls = [];
      pouring = false;
      var cb = pourDone;
      pourDone = null;
      if (cb) cb();
    }, 2200);
    wake();
  }

  function goToBatch(i, then) {
    if (batchCount < 1) return;
    i = ((i % batchCount) + batchCount) % batchCount;
    function dropNew() {
      batchIndex = i;
      fans = batches[i] ? batches[i].slice() : [];
      setBatchUi();
      startDrop();
      if (typeof then === "function") {
        var tries = 0;
        var t = setInterval(function () {
          tries++;
          if (then() || tries > 50) clearInterval(t);
        }, 80);
      }
    }
    if (balls.length || queue.length) startPour(dropNew);
    else dropNew();
  }

  function nextBatch() {
    if (batchCount < 2 || pouring) return;
    goToBatch((batchIndex + 1) % batchCount);
  }

  /* ---------- 物理 ---------- */
  function invM(b) { return drag && drag.ball === b ? 0 : 1 / b.m; }
  function invI(b) { return drag && drag.ball === b ? 0 : 1 / b.I; }

  function wallContact(b, nx, ny, pen) {
    b.x += nx * pen; b.y += ny * pen;
    var vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    var e = vn > -60 ? 0 : (b.kind === "bead" ? 0.38 : E_WALL);
    var jn = -(1 + e) * vn * b.m;
    b.vx += nx * jn / b.m; b.vy += ny * jn / b.m;
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
    var e = vn > -60 ? 0 : ((A.kind === "bead" && B.kind === "bead") ? 0.45 : E_BALL);
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

  function ballCollisions() {
    var n = balls.length, i, j;
    if (n <= 24) {
      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) ballContact(balls[i], balls[j]);
      }
      return;
    }
    var size = 16;
    for (i = 0; i < n; i++) if (balls[i].r * 2 > size) size = balls[i].r * 2;
    var cols = Math.max(1, Math.ceil(W / size) + 3);
    var buckets = [];
    for (i = 0; i < n; i++) {
      var b = balls[i];
      var cx = Math.floor(b.x / size);
      var cy = Math.floor(b.y / size);
      var id = (cy + 3) * cols + (cx + 2);
      if (!buckets[id]) buckets[id] = [];
      buckets[id].push(i);
      b._cx = cx; b._cy = cy;
    }
    for (i = 0; i < n; i++) {
      var A = balls[i], cx = A._cx, cy = A._cy;
      for (var oy = 0; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
          if (oy === 0 && ox < 0) continue;
          var list = buckets[(cy + oy + 3) * cols + (cx + ox + 2)];
          if (!list) continue;
          for (var k = 0; k < list.length; k++) {
            j = list[k];
            if (oy === 0 && ox === 0 && j <= i) continue;
            if (j === i) continue;
            ballContact(A, balls[j]);
          }
        }
      }
    }
  }

  function finishPour() {
    if (!pouring) return;
    clearTimeout(pourTimer);
    pouring = false;
    var cb = pourDone;
    pourDone = null;
    if (cb) cb();
  }

  function step(dt) {
    simTime += dt;
    if (!pouring && queue.length && simTime >= nextDropAt) {
      var burst = fans.length > 60 ? 2 : 1;
      while (burst-- && queue.length && simTime >= nextDropAt) spawn(queue.shift());
      nextDropAt = simTime + dropGap();
    }
    var floor = H - FLOOR_PAD;
    var i, b, leftover = [];
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      if (drag && drag.ball === b) {
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
      if (!b.entered && !b.exiting && b.y - b.r > 2) b.entered = true;
    }
    var iters = balls.length > 60 ? 2 : 3;
    for (var it = 0; it < iters; it++) {
      ballCollisions();
      for (i = 0; i < balls.length; i++) {
        b = balls[i];
        if (b.x - b.r < WALL_PAD) wallContact(b, 1, 0, WALL_PAD - (b.x - b.r));
        if (b.x + b.r > W - WALL_PAD) wallContact(b, -1, 0, b.x + b.r - (W - WALL_PAD));
        if (b.y + b.r > floor) wallContact(b, 0, -1, b.y + b.r - floor);
        if (!b.exiting && b.entered && b.y - b.r < 0) wallContact(b, 0, 1, -(b.y - b.r));
      }
    }
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      if (b.exiting && b.y + b.r < -24) continue;
      leftover.push(b);
      if (b.y + b.r > floor - 1.5 && !b.exiting) {
        b.w *= Math.exp(-1.1 * dt);
        b.vx *= Math.exp(-0.9 * dt);
        if (Math.abs(b.vx) < 3 && Math.abs(b.vy) < 25) { b.vx = 0; b.w *= 0.9; }
        if (b.kind === "avatar" && Math.abs(b.vx) < 6 && Math.abs(b.w) < 0.6 && !(drag && drag.ball === b)) {
          var up = Math.round(b.a / (Math.PI * 2)) * Math.PI * 2;
          b.a += (up - b.a) * (1 - Math.exp(-2.2 * dt));
          if (Math.abs(up - b.a) < 0.002) b.a = up;
        }
      }
    }
    balls = leftover;
    if (pouring && !balls.length) finishPour();
  }

  function energy() {
    var e = 0;
    balls.forEach(function (b) {
      var off = b.kind === "avatar" ? Math.abs(b.a - Math.round(b.a / (Math.PI * 2)) * Math.PI * 2) * b.r : 0;
      e = Math.max(e, Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.w) * b.r + off * 4);
    });
    return e;
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = balls.length > 50 ? "medium" : "high";
    var floor = H - FLOOR_PAD;
    var i, b;
    var skipBeadShadow = balls.length > 36;
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      if (skipBeadShadow && b.kind === "bead") continue;
      var gap = Math.max(0, floor - (b.y + b.r));
      var k = 1 - Math.min(1, gap / (H * 0.8));
      if (k <= 0.02) continue;
      var sw = b.r * (0.55 + 0.45 * k);
      var g = ctx.createRadialGradient(b.x, floor, 0, b.x, floor, sw);
      var alpha = (colors.light ? 0.26 : 0.5) * k * (b.kind === "bead" ? 0.55 : 1);
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
    for (i = 0; i < balls.length; i++) {
      if (balls[i].kind === "bead") drawBead(balls[i]);
      else drawBall(balls[i]);
    }
  }

  function goldRing(x, y, r) {
    var rg = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    rg.addColorStop(0, colors.ringA);
    rg.addColorStop(1, colors.ringB);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFoundRing(b) {
    if (b !== foundBall) return;
    var pulse = 0.5 + 0.5 * Math.sin(simTime * 8);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.5 * pulse;
    ctx.strokeStyle = colors.ringA;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + 5 + pulse * 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawBall(b) {
    var r = b.r, ring = Math.max(2, r * 0.05);
    var hot = b === tipBall || b === foundBall || (drag && drag.ball === b);
    ctx.save();
    if (b.fan.big || hot) {
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = b.fan.big ? (hot ? 34 : 24) : 16;
    }
    goldRing(b.x, b.y, r);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
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
      ctx.font = "700 " + Math.round(ir * 0.9) + "px " + bodyFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.fan.initial, 0, ir * 0.04);
    }
    ctx.rotate(-b.a);
    var hl = ctx.createRadialGradient(-ir * 0.38, -ir * 0.45, 0, -ir * 0.2, -ir * 0.25, ir * 1.15);
    hl.addColorStop(0, "rgba(255,255,255,0.38)");
    hl.addColorStop(0.35, "rgba(255,255,255,0.06)");
    hl.addColorStop(0.75, "rgba(0,0,0,0.04)");
    hl.addColorStop(1, "rgba(0,0,0,0.30)");
    ctx.fillStyle = hl;
    ctx.fillRect(-ir, -ir, ir * 2, ir * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(b.x, b.y, r - ring, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    drawFoundRing(b);
  }

  function drawBead(b) {
    var r = b.r, ring = Math.max(1.2, r * 0.22);
    var pal = b.fan.pal || BEAD_PALETTE[0];
    var hot = b === tipBall || b === foundBall || (drag && drag.ball === b);
    ctx.save();
    if (hot) {
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = 10;
    }
    goldRing(b.x, b.y, r);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    var ir = Math.max(1, r - ring);
    var fg = ctx.createRadialGradient(b.x - ir * 0.3, b.y - ir * 0.35, 0, b.x, b.y, ir);
    fg.addColorStop(0, pal[0]);
    fg.addColorStop(1, pal[1]);
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(b.x, b.y, ir, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath();
    ctx.ellipse(b.x - ir * 0.28, b.y - ir * 0.32, ir * 0.32, ir * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawFoundRing(b);
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
    if (foundBall && now > foundUntil) foundBall = null;
    var want = null;
    if (drag) want = drag.ball;
    else if (foundBall) want = foundBall;
    else if (tapBall && now < tapUntil) want = tapBall;
    else if (hoverBall && now < hoverUntil) want = hoverBall;
    if (want && balls.indexOf(want) < 0) want = null;
    setTip(want);
    if (want) placeTip();
  }

  /* ---------- 循环 ---------- */
  function noteFrame(rawDt) {
    if (rawDt <= 0 || rawDt > 0.2) return;
    var fps = 1 / rawDt;
    fpsEma = fpsEma * 0.9 + fps * 0.1;
    if (queue.length || pouring) return;
    if (simTime - lastAdaptAt < 2.2) return;
    if (fpsEma < 38 && balls.length > 24 && perfScale > 0.45) {
      fpsLowStreak += rawDt;
      if (fpsLowStreak > 1.2) {
        perfScale = Math.max(0.45, +(perfScale - 0.25).toFixed(2));
        lastAdaptAt = simTime;
        fpsLowStreak = 0;
        adaptToCaps();
      }
    } else {
      fpsLowStreak = 0;
    }
  }

  function adaptToCaps() {
    rebuildBatches();
    setBatchUi();
    applyHeight();
    var cap = computeCaps().screenCap;
    while (queue.length && balls.length + queue.length > cap) queue.pop();
    if (balls.length > cap) {
      balls.sort(function (a, b) { return a.fan.ord - b.fan.ord; });
      var extra = balls.splice(cap);
      extra.forEach(function (b) {
        b.exiting = true;
        b.entered = false;
        b.vy = -(700 + Math.random() * 400);
        balls.push(b);
      });
    }
    applyRadii();
    wake();
  }

  function frame(ts) {
    raf = 0;
    if (!active || !visible || document.hidden) return;
    var rawDt = lastTs ? (ts - lastTs) / 1000 : STEP;
    var dt = Math.min(0.05, rawDt);
    lastTs = ts;
    acc += dt;
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    draw();
    updateTip(performance.now());
    noteFrame(rawDt);
    if (!queue.length && !drag && !pouring && !foundBall && energy() < 6) idle += dt; else idle = 0;
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
      var pad = extra || 0;
      if (b.kind === "bead") pad += 4;
      if (d < b.r + pad && d < bd) { best = b; bd = d; }
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
    var s = Math.sqrt(48 / Math.max(24, b.r));
    if (b.kind === "bead") s = Math.min(s, 1.55);
    b.vy = -(900 + Math.random() * 420) * s;
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
  if (replayBtn) replayBtn.addEventListener("click", function () { if (!pouring) startDrop(); });
  if (batchBtn) batchBtn.addEventListener("click", function () { nextBatch(); });

  /* ---------- 找找我 ---------- */
  function showFindMsg(text) {
    if (!findMsg) return;
    findMsg.textContent = text || "";
    findMsg.classList.toggle("is-on", !!text);
    clearTimeout(findMsgTimer);
    if (text) findMsgTimer = setTimeout(function () { showFindMsg(""); }, 2800);
  }

  function matchFans(q) {
    q = (q || "").replace(/\s+/g, "");
    if (!q) return [];
    var ql = q.toLowerCase();
    var exact = [], start = [], ini = [];
    for (var i = 0; i < allFans.length; i++) {
      var f = allFans[i];
      var n = (f.name || "").replace(/\s+/g, "");
      var nl = n.toLowerCase();
      if (nl === ql) exact.push(f);
      else if (nl.indexOf(ql) === 0) start.push(f);
      else if (q.length === 1 && f.initial === q) ini.push(f);
    }
    return exact.concat(start, ini);
  }

  function batchIndexOf(fan) {
    var cap = computeCaps().screenCap;
    if (allFans.length <= cap) return 0;
    var i = fan.ord;
    if (i == null || i < 0) i = allFans.indexOf(fan);
    return Math.max(0, Math.floor(i / cap));
  }

  function sameFan(a, b) {
    return a === b || (a && b && a.name === b.name && a.ord === b.ord);
  }

  function highlightFan(fan) {
    var b = null, i;
    for (i = 0; i < balls.length; i++) if (sameFan(balls[i].fan, fan)) { b = balls[i]; break; }
    if (!b) {
      var qi = -1;
      for (i = 0; i < queue.length; i++) if (sameFan(queue[i], fan)) { qi = i; break; }
      if (qi >= 0) {
        b = spawn(queue.splice(qi, 1)[0]);
        b.y = Math.max(b.r + 10, H * 0.32);
        b.entered = true;
      }
    }
    if (!b) return false;
    foundBall = b;
    foundUntil = performance.now() + 3200;
    kick(b);
    hoverBall = b;
    hoverUntil = foundUntil;
    wake();
    return true;
  }

  function revealFan(fan) {
    var target = batchIndexOf(fan);
    if (target !== batchIndex || pouring) {
      goToBatch(target, function () { return highlightFan(fan); });
      return true;
    }
    return highlightFan(fan);
  }

  function onFind(e) {
    if (e) e.preventDefault();
    if (!active || !findInput) return;
    var q = findInput.value.replace(/\s+/g, "");
    if (!q) { showFindMsg(""); return; }
    var hits = matchFans(q);
    if (!hits.length) {
      showFindMsg("箱子里暂时没有这位");
      return;
    }
    revealFan(hits[0]);
    if (hits.length > 1) showFindMsg("找到 " + hits.length + " 位，先和这位打个招呼");
    else showFindMsg("找到了，就是这颗");
  }

  if (findForm) findForm.addEventListener("submit", onFind);

  /* ---------- 生命周期 ---------- */
  function setCount() {
    if (!countEl) return;
    countEl.replaceChildren();
    var bnum = document.createElement("b");
    bnum.textContent = String(allFans.length);
    countEl.appendChild(bnum);
    countEl.appendChild(document.createTextNode(" 位老粉丝已投进箱子"));
  }

  function setBatchUi() {
    var many = batchCount > 1;
    if (batchBtn) batchBtn.hidden = !many;
    if (batchIdxEl) {
      batchIdxEl.hidden = !many;
      if (many) batchIdxEl.textContent = "第 " + (batchIndex + 1) + " / " + batchCount + " 批";
    }
  }

  function syncLive() {
    rebuildBatches();
    setCount();
    setBatchUi();
    applyHeight();
    var byKey = {};
    fans.forEach(function (f) { byKey[fanKey(f)] = f; });
    balls = balls.filter(function (b) {
      var f = byKey[fanKey(b.fan)];
      if (f) {
        b.fan = f;
        b.kind = isAvatarFan(f) ? "avatar" : "bead";
        b.img = b.kind === "avatar" ? loadImg(f.src) : null;
        return true;
      }
      return false;
    });
    var have = {};
    balls.forEach(function (b) { have[fanKey(b.fan)] = 1; });
    queue = fans.filter(function (f) {
      return !have[fanKey(f)] && !queue.some(function (q) { return fanKey(q) === fanKey(f); });
    }).concat(queue.filter(function (q) { return byKey[fanKey(q)]; }));
    queue.sort(function (a, b) { return (a.ord - b.ord); });
    if (drag && balls.indexOf(drag.ball) < 0) drag = null;
    if (press && balls.indexOf(press.ball) < 0) press = null;
    if (tipBall && balls.indexOf(tipBall) < 0) hideTip();
    if (foundBall && balls.indexOf(foundBall) < 0) foundBall = null;
    applyRadii();
    if (queue.length && nextDropAt < simTime) nextDropAt = simTime + 0.1;
    wake();
    drawOnce();
  }

  function activate() {
    var reduce = mqReduce && mqReduce.matches;
    allFans = currentList();
    if (reduce || !allFans.length) {
      active = false;
      section.classList.remove("fanbox-on");
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      return;
    }
    var wasActive = active && W > 0;
    active = true;
    section.classList.add("fanbox-on");
    readColors();
    rebuildBatches();
    setCount();
    setBatchUi();
    applyHeight();
    if (wasActive && dropped && !overrideFans) {
      syncLive();
      return;
    }
    if (wasActive && dropped && overrideFans) {
      W = 0; H = 0;
      balls = []; queue = [];
      resize();
      startDrop();
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
    if (overrideFans) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(activate, 40);
  }
  window.ZN_refreshFanBox = refresh;

  if (window.ZN_FANBOX_DEBUG) {
    function fakeDate(i) {
      var d = new Date(Date.UTC(2025, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    }
    function makeFakeFans(spec) {
      if (Array.isArray(spec)) {
        return decorate(spec.map(function (f, i) {
          var o = {};
          for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k)) o[k] = f[k];
          o.idx = i;
          return o;
        }));
      }
      var n = Math.max(0, Math.floor(Number(spec) || 0));
      var xing = ["示", "例", "测", "试", "仿", "演", "样", "假"];
      var out = [];
      for (var i = 0; i < n; i++) {
        var name = xing[i % xing.length] + "*".repeat(1 + (i % 3));
        if (i > 0 && i % 90 === 89) name = "独" + "*".repeat(1 + (i % 3));
        var date = fakeDate(i);
        out.push({
          idx: i,
          name: name,
          badge: i === 0 ? "初代粉丝" : "",
          tag: "",
          when: i === 0 ? (date + " 前已关注") : ("关注于 " + date),
          date: date,
          src: "",
          initial: xing[i % xing.length],
          big: i === 0
        });
      }
      return decorate(out);
    }
    window.__fbDebug = function () {
      return {
        balls: balls.map(function (b) {
          return { x: b.x, y: b.y, r: b.r, kind: b.kind, name: b.fan.name, ord: b.fan.ord, big: !!b.fan.big };
        }),
        total: allFans.length,
        batchIndex: batchIndex,
        batchCount: batchCount,
        batchSize: fans.length,
        queue: queue.length,
        caps: computeCaps(),
        perfScale: perfScale,
        fps: Math.round(fpsEma),
        pouring: pouring,
        settled: !queue.length && !pouring && energy() < 6,
        width: W,
        height: H,
        found: foundBall ? foundBall.fan.name : null
      };
    };
    window.ZN_FANBOX_INJECT = function (spec) {
      overrideFans = makeFakeFans(spec);
      batchIndex = 0;
      perfScale = 1;
      fpsEma = 60;
      dropped = false;
      pouring = false;
      visible = true;
      try { stage.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) { /* 忽略 */ }
      activate();
      return window.__fbDebug();
    };
    window.ZN_FANBOX_NEXT_BATCH = function () { nextBatch(); return window.__fbDebug(); };
    window.ZN_FANBOX_FIND = function (q) {
      var hits = matchFans(q);
      if (hits[0]) revealFan(hits[0]);
      return { hits: hits.map(function (f) { return f.name; }), debug: window.__fbDebug() };
    };
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        visible = en.isIntersecting || !!overrideFans;
        if (visible && active && !dropped) startDrop();
        if (visible) wake();
      });
    }, { threshold: 0.25 }).observe(stage);
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
  new MutationObserver(refresh).observe(list, { childList: true });
  if (mqReduce) {
    if (mqReduce.addEventListener) mqReduce.addEventListener("change", activate);
    else if (mqReduce.addListener) mqReduce.addListener(activate);
  }
  if (mqNarrow && mqNarrow.addEventListener) {
    mqNarrow.addEventListener("change", function () { if (active) { applyHeight(); resize(); } });
  }

  activate();
  if (!visible && !("IntersectionObserver" in window) && active) startDrop();
})();
