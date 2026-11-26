/* 学习页密码门。学习监督系统更新 study/ 后，重新挂上的步骤：
 * 1. 把 index.html 里应用脚本的 type="module" 改成 type="zn-app"（src 保持不变）
 * 2. 在主题脚本之后、应用脚本之前引入本文件：<script src="./gate.js"></script>
 * 3. 补上 <meta name="robots" content="noindex"> 与 #root 的隐藏样式（见现有 index.html）
 * 本文件不含密码明文。更换密码时用生成脚本重写 CFG 后，已保存的解锁标记会失效。
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

  var STORAGE_KEY = "zn-study-gate";
  var STYLE_ID = "zn-study-gate-style";
  var GATE_ID = "zn-study-gate";
  var EXIT_ID = "zn-study-gate-exit";

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      hex += h.length === 1 ? "0" + h : h;
    }
    return hex;
  }

  function safeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
      return false;
    }
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function markValue() {
    return String(CFG.v) + ":" + CFG.iter + ":" + CFG.hashHex;
  }

  function isUnlocked() {
    try {
      return safeEqualHex(localStorage.getItem(STORAGE_KEY) || "", markValue());
    } catch (e) {
      return false;
    }
  }

  function persistUnlock() {
    try {
      localStorage.setItem(STORAGE_KEY, markValue());
    } catch (e) {}
  }

  function clearUnlock() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function whenReady(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function bootApp() {
    var placeholder = document.querySelector('script[type="zn-app"]');
    if (!placeholder || placeholder.getAttribute("data-booted") === "1") return;
    placeholder.setAttribute("data-booted", "1");
    var s = document.createElement("script");
    s.type = "module";
    var cors = placeholder.getAttribute("crossorigin");
    if (cors !== null) s.crossOrigin = cors === "" ? "" : cors;
    s.src = placeholder.getAttribute("src");
    placeholder.parentNode.insertBefore(s, placeholder.nextSibling);
  }

  async function deriveHex(password) {
    var enc = new TextEncoder();
    var material = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    var bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: hexToBytes(CFG.saltHex),
        iterations: CFG.iter
      },
      material,
      CFG.keyLen * 8
    );
    return bytesToHex(new Uint8Array(bits));
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "html:not(.zn-study-unlocked) #root{display:none!important;visibility:hidden!important}",
      "html:not(.zn-study-unlocked){background:var(--bg,#080809)}",
      "html[data-theme='light']:not(.zn-study-unlocked){background:var(--bg,#f4efe6)}",
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
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e2) {
      return "dark";
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("zn-theme", theme);
    } catch (e) {}
  }

  function unlockUi() {
    document.documentElement.classList.add("zn-study-unlocked");
    var gate = document.getElementById(GATE_ID);
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    mountExit();
    bootApp();
  }

  function mountExit() {
    if (document.getElementById(EXIT_ID)) return;
    var btn = document.createElement("button");
    btn.id = EXIT_ID;
    btn.type = "button";
    btn.textContent = "退出";
    btn.setAttribute("aria-label", "退出学习页并清除解锁状态");
    btn.addEventListener("click", function () {
      clearUnlock();
      window.location.reload();
    });
    (document.body || document.documentElement).appendChild(btn);
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
      '<p class="zn-gate-kicker">壮尼Ni</p>' +
      '<h1 id="zn-gate-title">学习监督系统</h1>' +
      '<p class="zn-gate-lead">这是壮尼的私人学习页，请输入密码进入。</p>' +
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
    var themeBtn = wrap.querySelector(".zn-gate-theme");

    themeBtn.addEventListener("click", function () {
      setTheme(currentTheme() === "light" ? "dark" : "light");
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var password = input.value;
      if (!password) {
        error.textContent = "请输入密码。";
        input.focus();
        return;
      }
      if (!window.crypto || !crypto.subtle) {
        error.textContent = "当前浏览器不支持安全验证，请换一个再试。";
        return;
      }
      error.textContent = "";
      submit.disabled = true;
      submit.textContent = "正在验证…";
      deriveHex(password)
        .then(function (got) {
          if (safeEqualHex(got, CFG.hashHex)) {
            persistUnlock();
            unlockUi();
            return;
          }
          error.textContent = "密码不正确，请再试一次。";
          input.value = "";
          input.focus();
        })
        .catch(function () {
          error.textContent = "验证时出了点问题，请再试一次。";
        })
        .then(function () {
          if (document.getElementById(GATE_ID)) {
            submit.disabled = false;
            submit.textContent = "进入";
          }
        });
    });

    setTimeout(function () {
      try { input.focus(); } catch (e) {}
    }, 0);
  }

  injectCss();
  if (isUnlocked()) {
    document.documentElement.classList.add("zn-study-unlocked");
    whenReady(function () {
      unlockUi();
    });
  } else {
    whenReady(mountGate);
  }
})();
