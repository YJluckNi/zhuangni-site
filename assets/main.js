/* 壮尼Ni 个人网站 — 共用交互 */

(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 移动端菜单 */
  const btn = document.querySelector(".menu-btn");
  const overlay = document.querySelector(".menu-overlay");
  function setMenu(open) {
    if (!btn || !overlay) return;
    btn.classList.toggle("is-open", open);
    overlay.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (btn && overlay) {
    btn.addEventListener("click", () => setMenu(!overlay.classList.contains("is-open")));
    overlay.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMenu(false);
    });
  }

  /* 导航滚动状态 */
  const header = document.querySelector(".site-header");
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* 进入视野动画 */
  const reveals = document.querySelectorAll(".reveal");
  if (reduce) {
    reveals.forEach((el) => el.classList.add("is-in"));
  } else if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  /* 进度条入场 */
  document.querySelectorAll(".track > span").forEach((bar) => {
    const play = () => bar.classList.add("is-in");
    if (reduce) return play();
    if (!("IntersectionObserver" in window)) return play();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          play();
          io.disconnect();
        }
      });
    }, { threshold: 0.4 });
    io.observe(bar);
  });

  /* 数字滚动（示例数据） */
  function animateCount(el) {
    const target = parseFloat(el.dataset.count || "0");
    const decimals = (el.dataset.count || "").includes(".") ? 1 : 0;
    if (reduce) {
      el.textContent = target.toFixed(decimals);
      return;
    }
    const dur = 1100;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  document.querySelectorAll("[data-count]").forEach((el) => {
    if (reduce) return animateCount(el);
    if (!("IntersectionObserver" in window)) return animateCount(el);
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          animateCount(el);
          io.disconnect();
        }
      });
    }, { threshold: 0.5 });
    io.observe(el);
  });

  /* 筛选标签 */
  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    const name = group.getAttribute("data-filter-group");
    const items = document.querySelectorAll(`[data-filter-item="${name}"]`);
    group.querySelectorAll("[data-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        group.querySelectorAll("[data-filter]").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        const key = chip.getAttribute("data-filter");
        items.forEach((item) => {
          const cats = (item.getAttribute("data-cats") || "").split(/\s+/);
          const show = key === "all" || cats.includes(key);
          item.classList.toggle("is-hidden", !show);
        });
      });
    });
  });

  /* 静态表单：不提交到任何地方 */
  const form = document.querySelector("form[data-static-form]");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = form.querySelector(".form-msg");
      if (msg) msg.classList.add("is-show");
    });
  }

  /* 深色 / 浅色 */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("zn-theme", t); } catch (err) {}
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      btn.setAttribute("aria-label", t === "dark" ? "切换为浅色外观" : "切换为深色外观");
      btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f4efe6" : "#080809");
  }
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.documentElement.classList.add("theme-ready");
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });
  applyTheme(currentTheme());
  requestAnimationFrame(() => document.documentElement.classList.add("theme-ready"));

  /* 词云：螺旋碰撞布局，数据来自页面内 ZN_CLOUD_WORDS */
  function initWordCloud() {
    const canvas = document.getElementById("word-cloud");
    const rankBox = document.getElementById("cloud-rank");
    const words = window.ZN_CLOUD_WORDS;
    if (!canvas || !Array.isArray(words) || !words.length) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sorted = words.slice().sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "zh"));
    const max = sorted[0].count || 1;

    if (rankBox) {
      const top = sorted.slice(0, 5);
      rankBox.innerHTML = top.map((w, i) => {
        const p = Math.round((w.count / max) * 100) + "%";
        const no = String(i + 1).padStart(2, "0");
        return `<li style="--i:${i};--p:${p}"><div class="rank-row"><span><span class="rank-no">${no}</span><span class="rank-word"></span></span></div><div class="rank-track"><span class="bar-fill" style="--p:${p}"></span></div></li>`;
      }).join("");
      rankBox.querySelectorAll(".rank-word").forEach((el, i) => { el.textContent = top[i].word; });
    }

    function tierOf(index) {
      if (index === 0) return "core";
      if (index <= 4) return "lg";
      if (index <= 14) return "md";
      if (index <= 24) return "sm";
      return "xs";
    }

    function fontSize(tier, width) {
      const map = {
        core: [44, Math.min(92, width * 0.105), 800, 1, 3],
        lg:   [22, Math.min(38, width * 0.044), 700, 0.96, 6],
        md:   [15, Math.min(23, width * 0.028), 600, 0.88, 8],
        sm:   [13, Math.min(17, width * 0.022), 500, 0.78, 10],
        xs:   [12, Math.min(15, width * 0.019), 500, 0.68, 11],
      };
      const [min, ideal, weight, op, pad] = map[tier];
      return { size: Math.max(min, ideal), weight, op, pad };
    }

    function hit(a, b, pad) {
      return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
    }

    function layout() {
      const width = canvas.clientWidth || 640;
      const height = canvas.clientHeight || 520;
      canvas.replaceChildren();
      const world = document.createElement("div");
      world.className = "cloud-world";
      canvas.appendChild(world);

      const placed = [];
      const measurer = document.createElement("span");
      measurer.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;left:0;top:0;";
      world.appendChild(measurer);

      sorted.forEach((item, index) => {
        const tier = tierOf(index);
        const fs = fontSize(tier, width);
        const vertical = !!item.vertical && tier !== "core" && tier !== "lg";
        measurer.style.fontSize = fs.size + "px";
        measurer.style.fontWeight = String(fs.weight);
        measurer.style.letterSpacing = vertical ? "0.18em" : (tier === "core" ? "0.08em" : "0.04em");
        measurer.style.writingMode = vertical ? "vertical-rl" : "horizontal-tb";
        measurer.textContent = item.word;
        const rect = measurer.getBoundingClientRect();
        const w = Math.ceil(rect.width) + 2;
        const h = Math.ceil(rect.height) + 2;

        let x = -w / 2;
        let y = -h / 2;
        if (index > 0) {
          let found = false;
          if (index <= 4) {
            const angles = [-0.28, 2.95, 0.62, 3.72];
            const dist = Math.max(placed[0].w, placed[0].h) * 0.58 + Math.max(w, h) * 0.55 + 12;
            const a0 = angles[index - 1];
            for (let k = 0; k < 60 && !found; k++) {
              const ang = a0 + (k % 2 === 0 ? 1 : -1) * 0.06 * Math.ceil(k / 2);
              const rr = dist + Math.floor(k / 8) * 6;
              const cx = Math.cos(ang) * rr * 1.08;
              const cy = Math.sin(ang) * rr * 0.82;
              const cand = { x: cx - w / 2, y: cy - h / 2, w, h };
              if (placed.every((p) => !hit(cand, p, fs.pad))) {
                x = cand.x; y = cand.y; found = true;
              }
            }
          }
          if (!found) {
            let theta = index * 0.7;
            let step = 0.18;
            const b = 5.2;
            const a = Math.max(placed[0].w, placed[0].h) * 0.42;
            for (let t = 0; t < 1600 && !found; t++) {
              const r = a + b * theta;
              const cand = {
                x: Math.cos(theta) * r * 1.15 - w / 2,
                y: Math.sin(theta) * r * 0.78 - h / 2,
                w, h
              };
              if (placed.every((p) => !hit(cand, p, fs.pad))) {
                x = cand.x; y = cand.y; found = true;
              }
              theta += step;
              if (t > 200) step = 0.14;
            }
          }
        }

        const el = document.createElement("span");
        el.className = "cloud-word is-" + tier + (vertical ? " is-vert" : "");
        el.setAttribute("tabindex", "0");
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.width = w + "px";
        el.style.height = h + "px";
        el.style.fontSize = fs.size + "px";
        el.style.fontWeight = String(fs.weight);
        el.style.setProperty("--o", String(fs.op));
        el.style.setProperty("--delay", (index * 0.045) + "s");
        el.style.setProperty("--drift", (index % 7) * 0.35 + "s");
        el.style.setProperty("--amp", (tier === "core" ? -2 : tier === "lg" ? -4 : -5) + "px");
        const inner = document.createElement("span");
        inner.className = "cloud-word-inner";
        inner.textContent = item.word;
        el.appendChild(inner);
        el.setAttribute("aria-label", item.word);
        world.appendChild(el);
        placed.push({ x, y, w, h, el });
      });
      measurer.remove();

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      placed.forEach((p) => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + p.w);
        maxY = Math.max(maxY, p.y + p.h);
      });
      const bw = maxX - minX;
      const bh = maxY - minY;
      const pad = 28;
      const scale = Math.min((width - pad) / bw, (height - pad) / bh, 1);
      world.style.transform = "translate(-50%, -50%) scale(" + scale.toFixed(4) + ")";

      const board = canvas.closest(".cloud-board") || canvas;
      const start = () => {
        canvas.classList.add("is-ready");
        if (!reduce) {
          window.setTimeout(() => {
            placed.forEach((p) => p.el.classList.add("is-floating"));
          }, 750 + sorted.length * 45);
        }
      };
      if (reduce) {
        canvas.classList.add("is-ready");
      } else if (board.classList.contains("is-in") || !document.documentElement.classList.contains("js")) {
        requestAnimationFrame(start);
      } else if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              start();
              io.disconnect();
            }
          });
        }, { threshold: 0.2 });
        io.observe(board);
      } else {
        start();
      }
    }

    layout();
    let timer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(layout, 180);
    });
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(initWordCloud).catch(initWordCloud);
  } else {
    initWordCloud();
  }

})();
