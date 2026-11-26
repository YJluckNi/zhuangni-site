/* 学习页挂载器（密码门 + 计划联动）—— study/index.html 不用改，只保留这一行：
 *     <script src="./gate.js"></script>
 * 学习监督系统更新 study/ 后，重新挂上的步骤：
 * 1. 把 index.html 里应用脚本的 type="module" 改成 type="zn-app"（src 保持不变）
 * 2. 在主题脚本之后、应用脚本之前引入本文件：<script src="./gate.js"></script>
 * 3. 补上 <meta name="robots" content="noindex"> 与 #root 的隐藏样式（见现有 index.html 的 #zn-gate-boot）
 * 4. 把本文件和 plan-link.js 一起放回 study/
 *
 * 本文件按顺序加载（全部是普通脚本，均不含密码明文或任何密钥）：
 *   ../assets/feishu-sync.js  只为拿到同一个 Worker 地址（window.ZN_FEISHU_ENDPOINT），本页没有可同步的板块
 *   ../plan/wbs.js            WBS 算法（计划拆解共用）
 *   ../assets/plan-core.js    计划 / 今日待办的本地缓存 + 飞书同步
 *   ./plan-link.js            悬浮「今日待办」面板 + 专注时长记到任务（必须在学习应用启动前装好钩子）
 *   ../assets/gate.js         公共密码门（与 /plan/ 共用一次解锁；解锁后才加载学习应用）
 */
(function () {
  "use strict";
  var me = document.currentScript;
  var base = me && me.src ? me.src.replace(/[^/]*$/, "") : "./";
  var list = [
    { src: base + "../assets/feishu-sync.js" },
    { src: base + "../plan/wbs.js" },
    { src: base + "../assets/plan-core.js" },
    { src: base + "plan-link.js" },
    {
      src: base + "../assets/gate.js",
      data: {
        root: "#root",
        "unlocked-class": "zn-study-unlocked",
        title: "学习监督系统",
        lead: "这是壮尼的私人学习页，请输入密码进入。"
      }
    }
  ];
  var anchor = me && me.parentNode ? me : null;
  list.forEach(function (item) {
    var s = document.createElement("script");
    s.async = false;
    s.src = item.src;
    if (item.data) for (var k in item.data) s.setAttribute("data-" + k, item.data[k]);
    if (anchor) anchor.parentNode.insertBefore(s, anchor.nextSibling), (anchor = s);
    else (document.head || document.documentElement).appendChild(s);
  });
})();
