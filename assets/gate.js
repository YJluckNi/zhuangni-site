/* 壮尼Ni 私人页面公共密码门（学习专注 /study/ 与 计划拆解 /plan/ 共用）
 *
 * - 同一个密码、同一个解锁标记：在任意一页输对一次，两页都直接进入（每台设备一次）。
 * - 解锁时还会用「另一个独立的盐」派生计划同步口令（PLAN_TOKEN 的同值），存进 localStorage，
 *   给计划拆解 / 今日待办 / 学习页联动调用 Worker 私人接口时作为 Authorization: Bearer 使用。
 *   这个口令 ≠ 下面公开的密码哈希，单凭本文件推不出口令。
 * - 解锁前不加载应用：页面里把应用脚本写成 <script type="zn-app" src="…">，解锁后按顺序加载
 *   （data-type="classic" 为普通脚本，默认按 ES module 加载，兼容学习页的构建产物）。
 * - 本文件不含密码明文。换密码时：重新生成 CFG.saltHex/hashHex（PBKDF2-SHA256）和 TOKEN.saltHex，
 *   并同步更新 Worker 的 PLAN_TOKEN；已保存的解锁标记会自动失效。
 *
 * 引入方式（在主题脚本之后、应用脚本之前）：
 *   <script src="../assets/gate.js" data-root="#app" data-title="计划拆解" data-lead="…" data-exit="#btnExit"></script>
 * 可选属性：
 *   data-root            解锁前隐藏的元素选择器（默认 [data-gate-root]）
 *   data-unlocked-class  解锁后额外加到 <html> 上的类（学习页用 zn-study-unlocked）
 *   data-title/data-lead 门上的标题和说明
 *   data-exit            「退出」按钮选择器；不填则在左上角放一个悬浮「退出」
 */
(function () {
  "use strict";

  var CFG = {
    v: 1,
    iter: 300000,
    saltHex: "5eac5bb1a22d60d1ac5399e0c663af61",
    hashHex: "21fa9599fa5cd3a1f85438b9cce078f1b6b29f5a2062d09413fff6350856900a",
    keyLen: 32
  };
  // 计划同步口令：独立盐，与上面的密码哈希无关
  var TOKEN = { iter: 200000, saltHex: "0a86cf50446ece00739b21a374081c82", keyLen: 32 };

  var STORAGE_KEY = "zn-gate-v1";
  var TOKEN_KEY = "zn-plan-token";
  var LEGACY_KEYS = ["zn-study-gate"];
  var STYLE_ID = "zn-study-gate-style";
  var GATE_ID = "zn-study-gate";
  var EXIT_ID = "zn-study-gate-exit";

  var me = document.currentScript;
  function opt(name, def) {
    var v = me && me.getAttribute("data-" + name);
    return v == null || v === "" ? def : v;
  }
  var ROOT_SEL = opt("root", "[data-gate-root]");
  var UNLOCKED_CLASS = opt("unlocked-class", "");
  var TITLE = opt("title", "私人页面");
  var LEAD = opt("lead", "这是壮尼的私人页面，请输入密码进入。");
  var EXIT_SEL = opt("exit", "");

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return hex;
  }
  function safeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  function markValue() {
    return String(CFG.v) + ":" + CFG.iter + ":" + CFG.hashHex;
  }
  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function isUnlocked() {
    return safeEqualHex(lsGet(STORAGE_KEY), markValue());
  }
  function clearUnlock() {
    lsDel(STORAGE_KEY);
    lsDel(TOKEN_KEY);
    for (var i = 0; i < LEGACY_KEYS.length; i++) lsDel(LEGACY_KEYS[i]);
  }

  async function pbkdf2Hex(password, saltHex, iter, keyLen) {
    var material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: iter }, material, keyLen * 8);
    return bytesToHex(new Uint8Array(bits));
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  /* 解锁后按文档顺序加载 <script type="zn-app"> */
  function bootApp() {
    var list = Array.prototype.slice.call(document.querySelectorAll('script[type="zn-app"]'));
    list.forEach(function (ph) {
      if (ph.getAttribute("data-booted") === "1") return;
      ph.setAttribute("data-booted", "1");
      var s = document.createElement("script");
      if (ph.getAttribute("data-type") === "classic") s.async = false;
      else s.type = "module";
      var cors = ph.getAttribute("crossorigin");
      if (cors !== null) s.crossOrigin = cors === "" ? "" : cors;
      s.src = ph.getAttribute("src");
      ph.parentNode.insertBefore(s, ph.nextSibling);
    });
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "html:not(.zn-gate-unlocked) " + ROOT_SEL.split(",").join(",html:not(.zn-gate-unlocked) ") + "{display:none!important;visibility:hidden!important}",
      "html:not(.zn-gate-unlocked){background:var(--bg,#080809)}",
      "html[data-theme='light']:not(.zn-gate-unlocked){background:var(--bg,#f4efe6)}",
      "#" + GATE_ID + "{position:fixed;inset:0;z-index:99980;display:flex;align-items:center;justify-content:center;padding:28px 20px;font-family:'Noto Sans CJK SC','Noto Sans SC','Source Han Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:var(--text,#f3f0e8);background:var(--bg,#080809);-webkit-font-smoothing:antialiased}",
      "html[data-theme='light'] #" + GATE_ID + "{color:#1c1914;background:#f4efe6}",
      "#" + GATE_ID + " .zn-gate-bg{position:absolute;inset:0;overflow:hidden;pointer-events:none}",
      "#" + GATE_ID + " .zn-gate-orb{position:absolute;border-radius:50%;filter:blur(40px);opacity:.9}",
      "#" + GATE_ID + " .zn-gate-orb-a{width:420px;height:420px;left:-120px;top:-80px;background:rgba(232,200,120,.28)}",
      "#" + GATE_ID + " .zn-gate-orb-b{width:360px;height:360px;right:-80px;bottom:-60px;background:rgba(120,170,170,.22)}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-orb-a{background:rgba(201,162,74,.22)}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-orb-b{background:rgba(120,150,140,.16)}",
      "#" + GATE_ID + " .zn-gate-card{position:relative;width:100%;max-width:420px;padding:36px 32px 32px;border-radius:18px;background:rgba(14,14,16,.72);border:1px solid rgba(243,240,232,.12);box-shadow:0 24px 60px rgba(0,0,0,.35);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-card{background:rgba(250,246,239,.92);border-color:rgba(28,25,20,.10);box-shadow:0 16px 40px rgba(40,30,10,.10)}",
      "#" + GATE_ID + " .zn-gate-kicker{margin:0 0 8px;font-size:12px;letter-spacing:.08em;color:var(--gold,#e8c878)}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-kicker{color:#7a5610}",
      "#" + GATE_ID + " h1{margin:0 0 10px;font-size:26px;font-weight:650;letter-spacing:.02em;line-height:1.25}",
      "#" + GATE_ID + " .zn-gate-lead{margin:0 0 28px;font-size:15px;line-height:1.7;color:#9a958b}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-lead{color:#5a554c}",
      "#" + GATE_ID + " label{display:block;margin:0 0 8px;font-size:13px;color:#9a958b}",
      "html[data-theme='light'] #" + GATE_ID + " label{color:#5a554c}",
      "#" + GATE_ID + " input[type='password']{width:100%;box-sizing:border-box;height:48px;padding:0 16px;border-radius:12px;border:1px solid rgba(243,240,232,.16);background:rgba(0,0,0,.28);color:inherit;font-size:16px;outline:none;transition:border-color .2s cubic-bezier(.22,1,.36,1),box-shadow .2s}",
      "html[data-theme='light'] #" + GATE_ID + " input[type='password']{background:rgba(255,255,255,.78);border-color:rgba(28,25,20,.16)}",
      "#" + GATE_ID + " input[type='password']:focus{border-color:#e8c878;box-shadow:0 0 0 3px rgba(232,200,120,.22)}",
      "html[data-theme='light'] #" + GATE_ID + " input[type='password']:focus{border-color:#7a5610;box-shadow:0 0 0 3px rgba(122,86,16,.16)}",
      "#" + GATE_ID + " .zn-gate-error{min-height:22px;margin:10px 0 0;font-size:13px;line-height:1.5;color:#f0a39a}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-error{color:#9a3324}",
      "#" + GATE_ID + " .zn-gate-submit{margin-top:16px;width:100%;height:48px;border:0;border-radius:999px;background:#e8c878;color:#1a1406;font-size:15px;font-weight:650;letter-spacing:.04em;cursor:pointer;transition:background .2s,transform .2s}",
      "#" + GATE_ID + " .zn-gate-submit:hover{background:#f0d58a;transform:translateY(-1px)}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-submit{background:#c9a24a}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-submit:hover{background:#d4b056}",
      "#" + GATE_ID + " .zn-gate-submit:disabled{opacity:.7;cursor:progress;transform:none}",
      "#" + GATE_ID + " .zn-gate-submit:focus-visible,#" + GATE_ID + " .zn-gate-theme:focus-visible,#" + EXIT_ID + ":focus-visible{outline:2px solid #e8c878;outline-offset:3px}",
      "#" + GATE_ID + " .zn-gate-theme{position:absolute;top:16px;right:16px;width:42px;height:42px;border-radius:10px;border:1px solid rgba(243,240,232,.16);background:rgba(255,255,255,.03);color:inherit;cursor:pointer;display:grid;place-items:center;padding:0}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-theme{border-color:rgba(28,25,20,.16);background:rgba(255,255,255,.55)}",
      "#" + GATE_ID + " .zn-gate-theme:hover{border-color:#c9a24a;color:#e8c878}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-gate-theme:hover{color:#7a5610}",
      "#" + GATE_ID + " .zn-gate-theme svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}",
      "html[data-theme='light'] #" + GATE_ID + " .zn-icon-moon{display:none}",
      "html:not([data-theme='light']) #" + GATE_ID + " .zn-icon-sun{display:none}",
      "#" + EXIT_ID + "{position:fixed;top:16px;left:16px;z-index:99970;height:36px;padding:0 14px;border-radius:999px;border:1px solid rgba(243,240,232,.16);background:rgba(14,14,16,.72);color:#f3f0e8;font-size:13px;font-family:'Noto Sans CJK SC','Noto Sans SC','Source Han Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;cursor:pointer;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}",
      "html[data-theme='light'] #" + EXIT_ID + "{background:rgba(250,246,239,.9);color:#1c1914;border-color:rgba(28,25,20,.16)}",
      "#" + EXIT_ID + ":hover{border-color:#c9a24a;color:#e8c878}",
      "html[data-theme='light'] #" + EXIT_ID + ":hover{color:#7a5610}",
      "@media (prefers-reduced-motion:reduce){#" + GATE_ID + " .zn-gate-submit{transition:none}#" + GATE_ID + " .zn-gate-submit:hover{transform:none}}"
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function currentTheme() {
    var html = document.documentElement.getAttribute("data-theme");
    if (html === "dark" || html === "light") return html;
    try {
      var stored = localStorage.getItem("zn-theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch (e) {}
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e2) { return "dark"; }
  }
  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    lsSet("zn-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f4efe6" : "#080809");
  }

  function markHtml() {
    var h = document.documentElement;
    h.classList.add("zn-gate-unlocked");
    if (UNLOCKED_CLASS) h.classList.add(UNLOCKED_CLASS);
  }

  function unlockUi() {
    markHtml();
    var gate = document.getElementById(GATE_ID);
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    mountExit();
    bootApp();
    try { window.dispatchEvent(new Event("zn-gate-unlocked")); } catch (e) {}
  }

  function doExit() {
    clearUnlock();
    window.location.reload();
  }

  function mountExit() {
    var custom = EXIT_SEL && document.querySelector(EXIT_SEL);
    if (custom) {
      if (!custom.getAttribute("data-gate-bound")) {
        custom.setAttribute("data-gate-bound", "1");
        custom.hidden = false;
        custom.addEventListener("click", doExit);
      }
      return;
    }
    if (document.getElementById(EXIT_ID)) return;
    var btn = document.createElement("button");
    btn.id = EXIT_ID;
    btn.type = "button";
    btn.textContent = "退出";
    btn.setAttribute("aria-label", "退出并清除这台设备的解锁状态");
    btn.addEventListener("click", doExit);
    (document.body || document.documentElement).appendChild(btn);
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function mountGate() {
    if (document.getElementById(GATE_ID)) return;
    var wrap = document.createElement("div");
    wrap.id = GATE_ID;
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "zn-gate-title");
    wrap.innerHTML =
      '<div class="zn-gate-bg" aria-hidden="true"><span class="zn-gate-orb zn-gate-orb-a"></span><span class="zn-gate-orb zn-gate-orb-b"></span></div>' +
      '<div class="zn-gate-card">' +
      '<button type="button" class="zn-gate-theme" aria-label="切换深浅色">' +
      '<svg class="zn-icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
      '<svg class="zn-icon-moon" viewBox="0 0 24 24"><path d="M20 14.5A7.5 7.5 0 1 1 9.5 4 6 6 0 0 0 20 14.5z"/></svg>' +
      "</button>" +
      '<p class="zn-gate-kicker">壮尼Ni · 私人空间</p>' +
      '<h1 id="zn-gate-title">' + esc(TITLE) + "</h1>" +
      '<p class="zn-gate-lead">' + esc(LEAD) + "</p>" +
      '<form class="zn-gate-form" autocomplete="off">' +
      '<label for="zn-gate-password">密码</label>' +
      '<input id="zn-gate-password" name="password" type="password" autocomplete="current-password" required spellcheck="false" />' +
      '<div class="zn-gate-error" role="alert" aria-live="polite"></div>' +
      '<button type="submit" class="zn-gate-submit">进入</button>' +
      "</form></div>";
    (document.body || document.documentElement).appendChild(wrap);

    var form = wrap.querySelector("form");
    var input = wrap.querySelector("#zn-gate-password");
    var error = wrap.querySelector(".zn-gate-error");
    var submit = wrap.querySelector(".zn-gate-submit");
    wrap.querySelector(".zn-gate-theme").addEventListener("click", function () {
      setTheme(currentTheme() === "light" ? "dark" : "light");
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var password = input.value;
      if (!password) { error.textContent = "请输入密码。"; input.focus(); return; }
      if (!window.crypto || !crypto.subtle) { error.textContent = "当前浏览器不支持安全验证，请换一个再试。"; return; }
      error.textContent = "";
      submit.disabled = true;
      submit.textContent = "正在验证…";
      Promise.all([
        pbkdf2Hex(password, CFG.saltHex, CFG.iter, CFG.keyLen),
        pbkdf2Hex(password, TOKEN.saltHex, TOKEN.iter, TOKEN.keyLen)
      ]).then(function (r) {
        password = "";
        if (safeEqualHex(r[0], CFG.hashHex)) {
          lsSet(STORAGE_KEY, markValue());
          lsSet(TOKEN_KEY, r[1]);
          unlockUi();
          return;
        }
        error.textContent = "密码不正确，请再试一次。";
        input.value = "";
        input.focus();
      }).catch(function () {
        error.textContent = "验证时出了点问题，请再试一次。";
      }).then(function () {
        if (document.getElementById(GATE_ID)) { submit.disabled = false; submit.textContent = "进入"; }
      });
    });
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
  }

  window.ZNGate = {
    isUnlocked: isUnlocked,
    token: function () { return isUnlocked() ? lsGet(TOKEN_KEY) : ""; },
    exit: doExit
  };

  injectCss();
  if (isUnlocked()) {
    markHtml();
    whenReady(unlockUi);
  } else {
    whenReady(mountGate);
  }
})();
