/* 壮尼Ni 个人网站 — 飞书多维表格同步
 *
 * 页面先显示写在 HTML 里的静态内容；如果配置了 Worker 地址、且不是用 file:// 打开，
 * 再去 Worker 拉最新数据替换列表。拉取失败、超时、或某一类数据为空时，保留静态内容，页面不会变空白。
 *
 * 需要改的只有下面的 FEISHU_ENDPOINT：部署好 Cloudflare Worker 后填它的地址，例如
 *   "https://zhuangni-feishu.你的子域.workers.dev"
 */
(function () {
  "use strict";

  var FEISHU_ENDPOINT = "https://zhuangni-feishu.yjluck2000.workers.dev"; // ← 部署 Worker 后填写；留空 = 不同步，只显示静态内容
  var TIMEOUT_MS = 5000;

  var root = document.documentElement;
  var isFile = location.protocol === "file:";
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  /* 本地调试：只有在 localhost 打开时，才允许用 ?feishu=http://localhost:8787 临时指定 Worker */
  function resolveEndpoint() {
    var ep = FEISHU_ENDPOINT;
    if (isLocal) {
      try {
        var q = new URLSearchParams(location.search).get("feishu");
        if (q && /^https?:\/\/[^\s"'<>]+$/.test(q)) ep = q;
      } catch (e) {}
    }
    return String(ep || "").replace(/\/+$/, "");
  }
  var ENDPOINT = isFile ? "" : resolveEndpoint();
  root.setAttribute("data-feishu", ENDPOINT ? "pending" : "off");

  /* ---------- 小工具 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function safeUrl(u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.indexOf("//") === 0) return "";
    return s.replace(/^\/+/, "");
  }
  function isExternal(u) { return /^https?:\/\//i.test(u); }
  function link(a, url) {
    a.href = url;
    if (isExternal(url)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }
  /* 网站端再兜底一次：首字 + 星号（Worker 已经做过，重复做结果不变） */
  function maskName(name) {
    var chars = Array.from(String(name || "").trim());
    if (!chars.length) return "匿*";
    var stars = Math.min(3, Math.max(1, chars.length - 1));
    return chars[0] + new Array(stars + 1).join("*");
  }
  function cnDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? m[1] + "年" + Number(m[2]) + "月" + Number(m[3]) + "日" : "";
  }

  /* 新渲染的元素也要有入场动效 */
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function reveal(nodes) {
    if (reduce || !("IntersectionObserver" in window)) {
      nodes.forEach(function (n) { n.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });
    nodes.forEach(function (n) { io.observe(n); });
  }

  function replaceList(container, nodes) {
    if (!container || !nodes.length) return false;
    container.replaceChildren.apply(container, nodes);
    container.setAttribute("data-feishu-rendered", "true");
    reveal(nodes);
    return true;
  }

  /* 渲染后重新套用当前选中的筛选标签 */
  function reapplyFilter(group) {
    var g = document.querySelector('[data-filter-group="' + group + '"]');
    var active = g && g.querySelector(".chip.is-active");
    if (active && active.getAttribute("data-filter") !== "all") active.click();
  }

  /* ---------- 各模块渲染 ---------- */
  function renderProjects(list) {
    var box = document.querySelector('[data-feishu-list="projects"]');
    var nodes = list.filter(function (p) { return p && p.title; }).map(function (p) {
      var card = el("article", "card reveal");
      card.setAttribute("data-filter-item", "projects");
      card.setAttribute("data-cats", (p.cats || []).join(" "));
      var cover = safeUrl(p.cover);
      if (cover) {
        var c = el("div", "card-cover");
        var img = el("img");
        img.src = cover; img.alt = p.title + "封面"; img.loading = "lazy";
        c.appendChild(img);
        card.appendChild(c);
      }
      var body = el("div", "card-body");
      body.appendChild(el("h3", "", p.title));
      if (p.summary) body.appendChild(el("p", "", p.summary));
      if (p.tags && p.tags.length) {
        var meta = el("div", "card-meta");
        p.tags.forEach(function (t) { meta.appendChild(el("span", "tag", t)); });
        body.appendChild(meta);
      }
      var href = safeUrl(p.link);
      if (href) {
        var foot = el("div", "card-foot");
        var a = el("a", "btn btn-ghost btn-sm", p.linkText || "查看详情");
        link(a, href);
        foot.appendChild(a);
        body.appendChild(foot);
      }
      card.appendChild(body);
      return card;
    });
    if (replaceList(box, nodes)) reapplyFilter("projects");
  }

  function renderArticles(list) {
    var box = document.querySelector('[data-feishu-list="articles"]');
    var nodes = list.filter(function (p) { return p && p.title; }).map(function (p) {
      var href = safeUrl(p.link);
      var row = el(href ? "a" : "div", "article-row reveal");
      if (href) link(row, href);
      row.setAttribute("data-filter-item", "articles");
      row.setAttribute("data-cats", (p.cats || []).join(" "));
      var cover = safeUrl(p.cover);
      if (cover) {
        var img = el("img");
        img.src = cover; img.alt = "文章封面：" + p.title; img.loading = "lazy";
        row.appendChild(img);
      } else {
        row.appendChild(el("span", "article-cover-empty"));
      }
      var mid = el("div");
      if (p.tag) mid.appendChild(el("span", "tag", p.tag));
      mid.appendChild(el("h3", "", p.title));
      if (p.summary) mid.appendChild(el("p", "", p.summary));
      row.appendChild(mid);
      var when = p.dateText || cnDate(p.date);
      if (p.minutes) when = (when ? when + " · " : "") + p.minutes + " 分钟";
      row.appendChild(el("span", "when", when));
      return row;
    });
    if (replaceList(box, nodes)) reapplyFilter("articles");
  }

  function renderComments(list) {
    var box = document.querySelector('[data-feishu-list="comments"]');
    var nodes = list.filter(function (c) { return c && c.text; }).map(function (c) {
      var card = el("article", "msg-card reveal");
      var q = el("div", "quote", "“");
      q.setAttribute("aria-hidden", "true");
      card.appendChild(q);
      card.appendChild(el("p", "", c.text));
      if (c.replies && c.replies.length) {
        var rs = el("div", "msg-replies");
        c.replies.forEach(function (r) {
          var item = el("div", "msg-reply" + (r.author ? " is-author" : ""));
          item.appendChild(el("p", "msg-reply-who", r.author ? "壮尼Ni 回复" : maskName(r.name)));
          item.appendChild(el("p", "", r.text));
          rs.appendChild(item);
        });
        card.appendChild(rs);
      }
      var foot = el("div", "msg-foot");
      var who = el("div", "who");
      who.appendChild(el("span", "", maskName(c.name)));
      if (c.date) {
        var t = el("time", "", cnDate(c.date));
        t.setAttribute("datetime", c.date);
        who.appendChild(t);
      }
      foot.appendChild(who);
      if (c.videoTitle) {
        var src = el("p", "msg-source");
        src.appendChild(document.createTextNode("来自视频《"));
        var vu = safeUrl(c.videoUrl);
        if (vu) { var a = el("a", "", c.videoTitle); link(a, vu); src.appendChild(a); }
        else src.appendChild(document.createTextNode(c.videoTitle));
        src.appendChild(document.createTextNode("》"));
        foot.appendChild(src);
      }
      card.appendChild(foot);
      return card;
    });
    if (box && nodes.length) box.classList.toggle("wall-grid--few", nodes.length <= 2);
    replaceList(box, nodes);
  }

  function renderFans(list) {
    var box = document.querySelector('[data-feishu-list="fans"]');
    var nodes = list.filter(function (f) { return f && f.name; }).map(function (f) {
      var name = maskName(f.name);
      var li = el("li", "fan-card reveal");
      var av = el("div", "fan-avatar");
      var src = safeUrl(f.avatar);
      if (src) {
        var img = el("img");
        img.src = src; img.width = 320; img.height = 320; img.alt = ""; img.loading = "lazy";
        av.appendChild(img);
      } else {
        av.classList.add("is-initial");
        av.appendChild(el("span", "", Array.from(name)[0]));
      }
      li.appendChild(av);
      var body = el("div", "fan-body");
      var row = el("div", "fan-name-row");
      row.appendChild(el("p", "fan-name", name));
      if (f.badge) row.appendChild(el("span", "fan-badge", f.badge));
      if (f.tag) row.appendChild(el("span", "fan-tag", f.tag));
      body.appendChild(row);
      if (f.date) {
        var p = el("p", "fan-when");
        var t = el("time", "", f.dateMode === "before" ? f.date + " 前已关注" : "关注于 " + f.date);
        t.setAttribute("datetime", f.date);
        p.appendChild(t);
        body.appendChild(p);
      }
      li.appendChild(body);
      return li;
    });
    replaceList(box, nodes);
  }

  function renderWords(list) {
    var words = list.filter(function (w) { return w && w.word && w.count > 0; })
      .map(function (w) { return { word: String(w.word), count: Number(w.count), vertical: !!w.vertical }; });
    if (words.length < 5 || !document.getElementById("word-cloud")) return;
    window.ZN_CLOUD_WORDS = words;
    if (typeof window.ZN_refreshWordCloud === "function") window.ZN_refreshWordCloud();
  }

  /* ---------- 拉取内容 ---------- */
  function wanted() {
    var keys = [];
    ["projects", "articles", "comments", "fans"].forEach(function (k) {
      if (document.querySelector('[data-feishu-list="' + k + '"]')) keys.push(k);
    });
    if (document.getElementById("word-cloud")) keys.push("words");
    return keys;
  }

  function fetchJson(url, opts) {
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    opts = opts || {};
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () { return { ok: false }; }).then(function (data) {
        data = data || {};
        data._status = res.status;
        return data;
      });
    }, function (err) { clearTimeout(timer); throw err; });
  }

  function loadContent() {
    var keys = wanted();
    if (!ENDPOINT || !keys.length || !window.fetch) return;
    fetchJson(ENDPOINT + "/api/content?only=" + keys.join(","), { credentials: "omit" }).then(function (d) {
      if (!d || d.ok !== true) throw new Error("bad");
      var done = [];
      var R = { projects: renderProjects, articles: renderArticles, comments: renderComments, fans: renderFans, words: renderWords };
      keys.forEach(function (k) {
        if (Array.isArray(d[k]) && d[k].length) {
          try { R[k](d[k]); done.push(k); } catch (e) { /* 单个模块出错不影响其他模块，保留静态内容 */ }
        }
      });
      root.setAttribute("data-feishu", "ok");
      root.setAttribute("data-feishu-source", d.source === "mock" ? "mock" : "feishu");
      root.setAttribute("data-feishu-done", done.join(" "));
    }).catch(function () {
      root.setAttribute("data-feishu", "fallback");
    });
  }

  /* ---------- 合作咨询表单 ---------- */
  function initContactForm() {
    var form = document.querySelector("form[data-feishu-form='contact']");
    if (!form) return;
    var openedAt = Date.now();
    var msg = form.querySelector(".form-msg");
    var btn = form.querySelector("button[type='submit']");
    var btnHtml = btn ? btn.innerHTML : ""; // 按钮里有两段文案（未接通/已接通），恢复时要整段还原

    function show(kind, text) {
      if (!msg) return;
      msg.textContent = text;
      msg.classList.remove("is-ok", "is-err", "is-wait");
      msg.classList.add("is-show", "is-" + kind);
    }
    function fieldError(name, text) {
      form.querySelectorAll("[aria-invalid='true']").forEach(function (n) { n.removeAttribute("aria-invalid"); });
      var n = name && form.querySelector("[name='" + name + "']");
      if (n) { n.setAttribute("aria-invalid", "true"); n.focus(); }
      show("err", text);
    }
    function len(s) { return Array.from(String(s || "").trim()).length; }

    var counter = form.querySelector("[data-count-for='message']");
    var ta = form.querySelector("[name='message']");
    if (counter && ta) {
      var upd = function () { counter.textContent = len(ta.value) + " / 1000"; };
      ta.addEventListener("input", upd);
      upd();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var data = {
        name: String(fd.get("name") || "").trim(),
        type: String(fd.get("type") || ""),
        contact: String(fd.get("contact") || "").trim(),
        budget: String(fd.get("budget") || ""),
        message: String(fd.get("message") || "").trim(),
        website: String(fd.get("website") || ""),
        page: location.pathname,
        elapsed_ms: Date.now() - openedAt
      };
      if (len(data.name) < 1 || len(data.name) > 30) return fieldError("name", "称呼请填 1–30 个字。");
      if (!data.type) return fieldError("type", "请选择合作类型。");
      if (len(data.contact) < 3 || len(data.contact) > 60) return fieldError("contact", "请留一个能联系到你的方式（3–60 个字）。");
      if (len(data.message) < 10 || len(data.message) > 1000) return fieldError("message", "需求描述请写 10–1000 个字。");
      form.querySelectorAll("[aria-invalid='true']").forEach(function (n) { n.removeAttribute("aria-invalid"); });

      if (!ENDPOINT) {
        show("err", form.getAttribute("data-offline-msg") || "表单暂未接通，内容不会被发送。请通过邮箱或抖音主页联系。");
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
      show("wait", "正在提交…");
      fetchJson(ENDPOINT + "/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "omit"
      }).then(function (d) {
        if (d.ok) {
          form.reset();
          if (counter && ta) counter.textContent = "0 / 1000";
          show("ok", "已收到，谢谢！我会尽快通过你留的联系方式回复。");
        } else if (d._status === 429) {
          show("err", "提交太频繁了，请过几分钟再试。");
        } else if (d.field) {
          fieldError(d.field, (d.error || "有一项没填对") + "。");
        } else {
          show("err", "提交没有成功（" + (d.error || "服务暂时不可用") + "）。可以稍后再试，或直接发邮件联系。");
        }
      }).catch(function () {
        show("err", "网络不通，提交没有成功。可以稍后再试，或直接发邮件联系。");
      }).then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
      });
    });
  }

  initContactForm();
  loadContent();
})();
