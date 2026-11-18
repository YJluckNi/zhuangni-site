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
})();
