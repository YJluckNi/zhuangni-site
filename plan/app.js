/* =========================================================================
   计划拆解 · WBS 工作分解   前端应用（壮尼Ni 网站版）
   来源：计划拆解/public/app.js。网站版改动：
   - 数据不再走本地 Node 服务：存 localStorage，联网时经 Worker 与飞书多维表格同步（assets/plan-core.js）
   - 新增「今日待办」（默认首页）、导入 JSON、去专注（跳学习页并预选任务）、同步状态
   - Excel 在浏览器里生成（plan/xlsx.js）；AI 拆解走 Worker 私人接口 /api/wbs-ai
   - 去掉「设置里填 API Key」和「对外接口说明」
   ========================================================================= */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const DAY = 86400000;

  const S = {
    plans: [],
    plan: null,
    mode: 'today',
    order: [],
    stats: null,
    selId: null,
    view: 'tree',
    expanded: new Set(),
    search: '',
    aiDraft: null,
    timer: null,
    dirty: false,
    saving: false
  };

  /* ---------------------------------------------------------------- */
  /* 基础工具                                                          */
  /* ---------------------------------------------------------------- */

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtShort(d) {
    if (!d) return '';
    const s = String(d);
    return s.slice(5, 10).replace('-', '/');
  }

  function toast(msg, type) {
    const box = $('#toasts');
    const t = el('div', 'toast' + (type ? ' ' + type : ''), msg);
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 2200);
    setTimeout(() => t.remove(), 2600);
  }

  let saveTimer = null;
  function showSave(text) {
    const s = $('#saveState');
    s.textContent = text;
    s.classList.add('show');
    clearTimeout(saveTimer);
    if (text === '已保存') saveTimer = setTimeout(() => s.classList.remove('show'), 1300);
  }

  const Z = window.ZNPlan;

  function summarize(p) {
    const c = WBS.compute(JSON.parse(JSON.stringify(p)));
    return { id: p.id, title: p.title, goal: p.goal, updatedAt: p.updatedAt, stats: c.stats };
  }

  /* AI 请求：走 Worker 私人接口；错误转成好懂的话 */
  async function aiRequest(body) {
    try {
      const d = await Z.request('POST', '/api/wbs-ai', body);
      return d.data;
    } catch (e) {
      if (e.status === 401) throw new Error('AI 口令失效：请点右上角「退出」后重新输入密码。也可以用「复制提示词 / 粘贴结果」手动拆解。');
      if (e.offline) throw new Error('连不上 AI 中转（可能是网络限制）。可以用「复制提示词」发给任意 AI，再「粘贴结果」。');
      throw e;
    }
  }

  /* 截止日约束：给线上 Worker 的提示词补一段硬约束（Worker 新版提示词也会自带，重复无害） */
  function deadlineExtra(start, end, extra) {
    const days = ZNPrompts.spanDays(start, end);
    if (!days) return extra || '';
    const hard = '【时间硬约束，优先于其它所有规则】计划从 ' + start + ' 开始，最晚 ' + end + ' 完成，共 ' + days +
      ' 个自然日（含首尾）。所有叶子节点按顺序首尾相接时 duration 之和必须 ≤ ' + days + '；叶子 duration 可以是 1 天；放不下就合并或减少叶子，绝不能超出期限。';
    return (hard + (extra ? '\n' + extra : '')).slice(0, 2000);
  }

  /** 把排期结果写成一句话（AI 预览、提示条、toast 共用） */
  function fitText(r) {
    if (!r) return '';
    if (r.status === 'compressed') return '已按截止日压缩：原排期 ' + r.beforeDays + ' 天 → ' + r.afterDays + ' 天（最晚 ' + fmtShort(r.lastEnd) + '）';
    if (r.status === 'ok') return '排期 ' + r.afterDays + ' 天，在截止日内';
    if (r.status === 'nodeadline') return '未设截止日期，按顺序排期共 ' + r.beforeDays + ' 天';
    if (r.status === 'baddeadline') return '截止日期早于开始日期，未调整排期';
    if (r.status === 'over') return '超出截止日 ' + r.overDays + ' 天';
    return '';
  }

  function confirmDialog(title, message, okText) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'dlg';
      dlg.innerHTML = '<div class="dlg-head"><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p></div>' +
        '<div class="dlg-foot"><button class="wb-btn ghost" data-no>取消</button>' +
        '<button class="wb-btn accent" data-yes>' + esc(okText || '确定') + '</button></div>';
      document.body.appendChild(dlg);
      dlg.showModal();
      dlg.addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-no') || e.target === dlg) { dlg.close(); resolve(false); }
        if (e.target.hasAttribute('data-yes')) { dlg.close(); resolve(true); }
      });
      dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 状态                                                              */
  /* ---------------------------------------------------------------- */

  function byId(id) {
    return S.plan && S.plan.nodes.filter((n) => n.id === id)[0];
  }

  function selected() {
    return S.selId ? byId(S.selId) : null;
  }

  function recompute() {
    if (!S.plan) { S.order = []; S.stats = null; return; }
    const c = WBS.compute(S.plan);
    S.order = c.nodes;
    S.stats = c.stats;
    return c;
  }

  function expandAll(flag) {
    if (!S.plan) return;
    S.expanded = new Set();
    if (flag) {
      S.plan.nodes.forEach((n) => {
        const has = S.plan.nodes.some((x) => x.parentId === n.id);
        if (has) S.expanded.add(n.id);
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 保存                                                              */
  /* ---------------------------------------------------------------- */

  function scheduleSave() {
    S.dirty = true;
    clearTimeout(S.timer);
    S.timer = setTimeout(saveNow, 650);
  }

  async function saveNow() {
    if (!S.plan) return;
    clearTimeout(S.timer);
    if (!S.dirty) return;
    S.dirty = false;
    S.saving = true;
    showSave('保存中…');
    const p = S.plan;
    try {
      const saved = Z.savePlan(p);
      p.updatedAt = saved.updatedAt;
      const fm = {};
      saved.nodes.forEach((n) => { fm[n.id] = n.focusMin; });
      p.nodes.forEach((n) => { if (fm[n.id] != null) n.focusMin = fm[n.id]; });
      showSave('已保存');
      const sum = summarize(saved);
      const i = S.plans.findIndex((x) => x.id === p.id);
      if (i >= 0) S.plans[i] = sum; else S.plans.unshift(sum);
      renderRail();
    } catch (e) {
      S.dirty = true;
      showSave('保存失败');
      toast('保存失败：' + e.message, 'err');
    } finally {
      S.saving = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 计划加载                                                          */
  /* ---------------------------------------------------------------- */

  async function loadPlans() {
    try {
      S.plans = Z.listPlans().map(summarize);
      renderRail();
      return S.plans;
    } catch (e) {
      toast('读取本机计划失败：' + e.message, 'err');
      S.plans = [];
      renderRail();
      return [];
    }
  }

  async function openPlan(id) {
    if (S.dirty) await saveNow();
    try {
      const data = Z.getPlan(id);
      if (!data) throw new Error('计划不存在');
      S.plan = WBS.normalizePlan(data);
      S.plan.id = id;
      S.mode = 'plan';
      document.body.classList.remove('rail-open');
      S.selId = null;
      S.expanded = new Set();
      S.plan.nodes.forEach((n) => {
        if (S.plan.nodes.some((x) => x.parentId === n.id)) S.expanded.add(n.id);
      });
      localStorage.setItem('wbs.lastPlan', id);
      recompute();
      renderAll();
    } catch (e) {
      toast('打开计划失败：' + e.message, 'err');
    }
  }

  async function createPlan(payload) {
    const plan = WBS.normalizePlan({
      id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: payload.title || '未命名计划',
      goal: payload.goal || '',
      owner: payload.owner || '',
      startDate: payload.startDate || Z.bjDate(),
      endDate: payload.endDate || '',
      nodes: payload.nodes || []
    });
    const saved = Z.savePlan(plan);
    S.plans.unshift(summarize(saved));
    renderRail();
    await openPlan(saved.id);
    return saved;
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：左侧列表                                                     */
  /* ---------------------------------------------------------------- */

  function renderRail() {
    const list = $('#planList');
    list.innerHTML = '';
    const td = Z.today();
    const entry = el('div', 'wb-plan wb-today-entry' + (S.mode === 'today' ? ' on' : ''));
    const et = el('div', 'pi-title');
    et.appendChild(el('span', 'wb-today-dot'));
    et.appendChild(document.createTextNode('今日待办'));
    entry.appendChild(et);
    const em = el('div', 'pi-meta');
    const eb = el('div', 'pi-bar');
    const ef = el('i');
    ef.style.width = (td.total ? Math.round(td.done / td.total * 100) : 0) + '%';
    eb.appendChild(ef);
    em.appendChild(eb);
    em.appendChild(el('span', '', td.done + '/' + td.total + (td.overdue ? ' · 逾期 ' + td.overdue : '')));
    entry.appendChild(em);
    entry.addEventListener('click', () => showToday());
    list.appendChild(entry);
    list.appendChild(el('div', 'wb-rail-label', '我的计划'));
    const q = S.search.trim().toLowerCase();
    const items = S.plans.filter((p) => {
      if (!q) return true;
      return (String(p.title) + ' ' + String(p.goal)).toLowerCase().indexOf(q) >= 0;
    });

    if (!items.length) {
      const d = el('div', '', q ? '没有匹配的计划' : '还没有计划，点上方 ＋ 新建');
      d.style.cssText = 'padding:24px 12px;text-align:center;color:var(--w-muted);font-size:12px;line-height:1.7';
      list.appendChild(d);
      return;
    }

    items.forEach((p) => {
      const item = el('div', 'wb-plan' + (S.mode === 'plan' && S.plan && S.plan.id === p.id ? ' on' : ''));
      const t = el('div', 'pi-title', p.title || '未命名计划');
      const m = el('div', 'pi-meta');
      const bar = el('div', 'pi-bar');
      const fill = el('i');
      fill.style.width = ((p.stats && p.stats.progress) || 0) + '%';
      bar.appendChild(fill);
      m.appendChild(bar);
      m.appendChild(el('span', '', ((p.stats && p.stats.total) || 0) + ' 项'));
      item.appendChild(t);
      item.appendChild(m);
      item.addEventListener('click', () => openPlan(p.id));
      item.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        if (await confirmDialog('删除计划', '将永久删除「' + p.title + '」及其全部工作项，无法撤销。', '删除')) {
          try {
            Z.deletePlan(p.id);
            S.plans = S.plans.filter((x) => x.id !== p.id);
            if (S.plan && S.plan.id === p.id) { S.plan = null; S.order = []; }
            renderAll();
            toast('已删除');
          } catch (err) { toast('删除失败：' + err.message, 'err'); }
        }
      });
      list.appendChild(item);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：顶部与统计                                                   */
  /* ---------------------------------------------------------------- */

  function renderTopbar() {
    document.body.classList.toggle('mode-today', S.mode === 'today');
    if (S.mode === 'today') {
      const t = $('#planTitle');
      t.textContent = '今日待办';
      t.setAttribute('contenteditable', 'false');
      $('#planGoal').textContent = todayLabel() + ' · 所有计划里今天该做的工作包，加上临时待办';
      return;
    }
    const has = !!S.plan;
    const title = $('#planTitle');
    if (document.activeElement !== title) title.textContent = has ? S.plan.title : '未选择计划';
    title.setAttribute('contenteditable', has ? 'true' : 'false');

    const goal = $('#planGoal');
    goal.textContent = has ? (S.plan.goal || '') : '';

    $('#btnAi').disabled = !has;
    $('#btnAddRoot').disabled = !has;
    $('#btnExport').disabled = !has;
  }

  function renderMeta() {
    const bar = $('#metaBar');
    bar.innerHTML = '';
    if (S.mode === 'today') return renderTodayMeta(bar);
    if (!S.plan) return;
    const c = WBS.compute(S.plan);
    const v = WBS.validate(S.plan);
    const warn = v.issues.filter((i) => i.level === 'warn').length;

    function stat(value, label, cls) {
      const d = el('div', 'mstat' + (cls ? ' ' + cls : ''));
      d.appendChild(el('b', '', value));
      d.appendChild(el('span', '', label));
      return d;
    }

    bar.appendChild(stat(c.stats.progress + '%', '整体进度'));
    bar.appendChild(el('div', 'mstat-sep'));
    bar.appendChild(stat(c.stats.total, '工作项'));
    bar.appendChild(stat(c.stats.leaves, '叶子节点'));
    bar.appendChild(stat(c.stats.done, '已完成'));
    bar.appendChild(el('div', 'mstat-sep'));

    const chk = stat(warn ? warn : '通过', '结构检查');
    if (warn) chk.classList.add('warn');
    chk.style.cursor = 'pointer';
    chk.addEventListener('click', openCheck);
    bar.appendChild(chk);

    const span = WBS.dateSpan(S.plan);
    const right = el('div', 'mstat grow');
    right.appendChild(el('span', '', '排期范围 '));
    const b = el('b', '', fmtShort(span.start) + ' — ' + fmtShort(span.end));
    b.style.fontSize = '12px';
    b.style.fontWeight = '500';
    right.appendChild(b);
    if (S.dirty || S.saving) {
      const s = el('span', '', S.saving ? ' · 保存中' : ' · 未保存');
      right.appendChild(s);
    }
    bar.appendChild(right);

    // 截止日检查：超期 / 未排期 → 一键修正
    const info = WBS.scheduleInfo(S.plan);
    if (S.plan.endDate && info.overDays > 0) {
      const chip = el('button', 'wb-deadline over', '超出截止日 ' + info.overDays + ' 天 · 压缩到截止日');
      chip.type = 'button';
      chip.title = '最晚 ' + info.lastEnd + ' 结束，计划截止 ' + S.plan.endDate + '。按比例把排期压回计划区间（保持先后顺序，允许同一天多项）';
      chip.addEventListener('click', () => fitPlanToDeadline(false));
      bar.appendChild(chip);
    } else if (info.unscheduled > 0 && (S.plan.startDate || S.plan.endDate)) {
      const chip = el('button', 'wb-deadline', info.unscheduled + ' 项未排期 · 自动排期');
      chip.type = 'button';
      chip.title = '按工期接在已排期的后面；超出截止日时自动压缩到计划区间';
      chip.addEventListener('click', () => fitPlanToDeadline(true));
      bar.appendChild(chip);
    } else if (S.plan.endDate && S.lastFit && S.lastFit.planId === S.plan.id && S.lastFit.status === 'compressed') {
      bar.appendChild(el('span', 'wb-deadline ok', fitText(S.lastFit)));
    }
  }

  /** 把当前计划的排期约束到「开始 ~ 截止」：fill=true 时顺便给未排期的叶子排上 */
  function fitPlanToDeadline(fill) {
    if (!S.plan) return;
    const start = S.plan.startDate || Z.bjDate();
    if (S.plan.endDate && S.plan.endDate < start) { toast('截止日期早于开始日期，请先在「属性」里改一下', 'err'); return; }
    const r = WBS.fitSchedule(S.plan.nodes, start, S.plan.endDate, { fillMissing: !!fill, today: Z.bjDate() });
    if (!S.plan.startDate) S.plan.startDate = start;
    S.lastFit = Object.assign({ planId: S.plan.id }, r);
    recompute();
    scheduleSave();
    renderAll();
    const msg = r.status === 'compressed' ? fitText(r) : (r.filled ? '已排期 ' + r.filled + ' 项' + (r.status === 'ok' ? '，都在截止日内' : '') : fitText(r));
    toast(msg || '排期已更新', 'ok');
  }

  function renderAll() {
    recompute();
    renderTopbar();
    renderMeta();
    renderStage();
    renderInspector();
    renderRail();
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：视图分发                                                     */
  /* ---------------------------------------------------------------- */

  function renderStage() {
    const stage = $('#stage');
    if (S.mode === 'today') { renderToday(stage); return; }
    stage.innerHTML = '';
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));

    if (!S.plan) {
      stage.innerHTML = '<div class="empty"><div class="empty-mark">WBS</div>' +
        '<h2>还没有打开任何计划</h2>' +
        '<p>在左侧新建一个计划，输入目标后用 AI 拆解，或手工从一级工作项开始搭建。</p>' +
        '<button class="wb-btn accent" id="btnEmptyNew">新建计划</button></div>';
      $('#btnEmptyNew').addEventListener('click', () => openPlanDialog());
      return;
    }

    if (S.view === 'tree') renderTree(stage);
    else if (S.view === 'table') renderTable(stage);
    else renderGantt(stage);
  }

  /* ---------------------------------------------------------------- */
  /* 树视图                                                            */
  /* ---------------------------------------------------------------- */

  function renderTree(stage) {
    const c = WBS.compute(S.plan);
    const wrap = el('div', 'tree');

    const head = el('div', 'tree-head');
    ['', '工作项', '责任人', '起止日期', '进度', '状态', ''].forEach((t) => head.appendChild(el('span', '', t)));
    wrap.appendChild(head);

    const visible = [];
    (function walk(parentId) {
      c.nodes.filter((n) => (n.parentId || null) === (parentId || null)).forEach((n) => {
        visible.push(n);
        if (n.hasChildren && S.expanded.has(n.id)) walk(n.id);
      });
    })('');

    let dragId = null;

    function clearMarks() {
      $$('.trow', wrap).forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-into'));
    }

    visible.forEach((node) => {
      const row = el('div', 'trow' + (node.hasChildren ? ' branch' : '') + (node.id === S.selId ? ' sel' : ''));
      row.dataset.id = node.id;
      row.dataset.level = node.level;
      row.style.setProperty('--depth', node.level - 1);
      row.tabIndex = 0;

      /* 拖拽手柄 */
      const handle = el('span', 'drag-handle', '⠿');
      handle.draggable = true;
      handle.addEventListener('dragstart', (e) => {
        dragId = node.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', node.id);
        try { e.dataTransfer.setDragImage(row, 40, 20); } catch (_) {}
        row.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        dragId = null;
        row.classList.remove('dragging');
        clearMarks();
      });
      row.appendChild(handle);

      /* 主体 */
      const tw = el('div', 'tw');
      const caret = el('button', 'caret' + (node.hasChildren ? '' : ' empty') + (S.expanded.has(node.id) ? ' open' : ''), '▶');
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (S.expanded.has(node.id)) S.expanded.delete(node.id);
        else S.expanded.add(node.id);
        renderStage();
        renderInspector();
      });
      tw.appendChild(caret);
      tw.appendChild(el('span', 'code', node.code));

      const title = el('span', 'ttitle', node.title);
      title.title = node.title;
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); beginEdit(title, node); });
      tw.appendChild(title);
      row.appendChild(tw);

      /* 责任人 */
      const owner = el('div', 'cell-owner' + (node.owner ? '' : ' empty'), node.owner || '—');
      owner.title = node.owner || '';
      row.appendChild(owner);

      /* 日期 */
      const dates = el('div', 'cell-dates' + (node.startDate ? '' : ' empty'),
        node.startDate ? fmtShort(node.startDate) + ' → ' + fmtShort(node.endDate) : '未排期');
      dates.title = (node.startDate || '') + (node.endDate ? ' ~ ' + node.endDate : '');
      row.appendChild(dates);

      /* 进度 */
      const prog = el('div', 'prog' + (node.progress >= 100 ? ' done' : ''));
      const bar = el('div', 'prog-bar');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, node.progress)) + '%';
      bar.appendChild(fill);
      prog.appendChild(bar);
      prog.appendChild(el('span', 'prog-num', node.progress + '%'));
      row.appendChild(prog);

      /* 状态 */
      row.appendChild(el('span', 'wb-chip ' + node.status, WBS.STATUS_TEXT[node.status] || node.status));

      /* 行内操作 */
      const acts = el('div', 'row-actions');
      const addBtn = el('button', '', '＋');
      addBtn.title = '添加子项';
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); addChild(node.id, null, null); });
      const delBtn = el('button', 'del', '×');
      delBtn.title = '删除';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); removeNode(node); });
      if (!node.hasChildren) {
        const fBtn = el('button', 'focus', '▶');
        fBtn.title = '去专注（打开学习页并选中这一项）';
        fBtn.addEventListener('click', (e) => { e.stopPropagation(); goFocus({ kind: 'task', planId: S.plan.id, id: node.id }); });
        acts.appendChild(fBtn);
      }
      acts.appendChild(addBtn);
      acts.appendChild(delBtn);
      row.appendChild(acts);

      row.addEventListener('click', () => selectNode(node.id));
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('.ttitle') || e.target.closest('button')) return;
        beginEdit(title, node);
      });

      /* 拖放 */
      row.addEventListener('dragover', (e) => {
        if (!dragId || dragId === node.id) return;
        if (WBS.descendants(S.plan.nodes, dragId).indexOf(node.id) >= 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const p = (e.clientY - r.top) / r.height;
        row.classList.remove('drop-before', 'drop-after', 'drop-into');
        if (p < 0.28) row.classList.add('drop-before');
        else if (p > 0.72) row.classList.add('drop-after');
        else row.classList.add('drop-into');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drop-before', 'drop-after', 'drop-into');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const mode = row.classList.contains('drop-before') ? 'before'
          : row.classList.contains('drop-after') ? 'after' : 'into';
        clearMarks();
        if (!dragId || dragId === node.id) return;
        handleDrop(dragId, node.id, mode);
        dragId = null;
      });

      wrap.appendChild(row);
    });

    stage.appendChild(wrap);

    /* 键盘 */
    wrap.addEventListener('keydown', (e) => {
      const row = e.target.closest ? e.target.closest('.trow') : null;
      if (!row) return;
      const node = byId(row.dataset.id);
      if (!node) return;
      if (e.target.isContentEditable) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) outdent(node); else indent(node);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addChild(node.parentId, node.id, null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeNode(node);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = $$('.trow', wrap);
        const i = rows.indexOf(row);
        const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });
  }

  function beginEdit(span, node) {
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = (commit) => {
      span.contentEditable = 'false';
      if (commit) {
        const v = span.textContent.trim();
        if (v && v !== node.title) {
          node.title = v;
          scheduleSave();
        } else {
          span.textContent = node.title;
        }
        renderStage();
        renderInspector();
        renderMeta();
      } else {
        span.textContent = node.title;
      }
      span.removeEventListener('blur', onBlur);
      span.removeEventListener('keydown', onKey);
    };
    const onBlur = () => finish(true);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    span.addEventListener('blur', onBlur);
    span.addEventListener('keydown', onKey);
  }

  function handleDrop(dragId, targetId, mode) {
    const target = byId(targetId);
    if (!target) return;
    let parentId, index;
    if (mode === 'into') {
      parentId = targetId;
      index = WBS.siblings(S.plan.nodes, parentId).filter((n) => n.id !== dragId).length;
    } else {
      parentId = target.parentId || null;
      const sibs = WBS.siblings(S.plan.nodes, parentId).filter((n) => n.id !== dragId);
      const i = sibs.findIndex((n) => n.id === targetId);
      index = mode === 'before' ? Math.max(0, i) : i + 1;
    }
    WBS.moveNode(S.plan.nodes, dragId, parentId, index);
    WBS.normalizeOrder(S.plan.nodes);
    if (parentId) S.expanded.add(parentId);
    recompute();
    scheduleSave();
    renderStage();
    renderInspector();
    renderMeta();
  }

  /* ---------------------------------------------------------------- */
  /* 节点操作                                                          */
  /* ---------------------------------------------------------------- */

  function selectNode(id) {
    S.selId = id;
    $$('.trow').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    $$('#stage tr[data-id]').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    $$('.g-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    renderInspector();
    document.body.classList.remove('inspector-hidden');
    if (window.innerWidth <= 1280) document.body.classList.add('isp-open');
  }

  function addChild(parentId, afterId, init) {
    if (parentId && typeof parentId !== 'string') parentId = null;
    if (afterId && typeof afterId !== 'string') afterId = null;
    const node = WBS.addNode(S.plan.nodes, parentId || null, afterId || null, init || {});
    WBS.normalizeOrder(S.plan.nodes);
    if (parentId) S.expanded.add(parentId);
    S.selId = node.id;
    recompute();
    scheduleSave();
    renderStage();
    renderInspector();
    renderMeta();

    const row = $('.trow[data-id="' + node.id + '"]');
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      row.focus();
      const span = $('.ttitle', row);
      if (span) beginEdit(span, node);
    }
  }

  async function removeNode(node) {
    const n = WBS.descendants(S.plan.nodes, node.id).length;
    const msg = n ? '将同时删除其下 ' + n + ' 个子项，无法撤销。' : '删除后无法撤销。';
    if (!(await confirmDialog('删除工作项', '「' + node.title + '」：' + msg, '删除'))) return;
    S.plan.nodes = WBS.removeNode(S.plan.nodes, node.id);
    WBS.normalizeOrder(S.plan.nodes);
    if (S.selId === node.id) S.selId = null;
    recompute();
    scheduleSave();
    renderStage();
    renderInspector();
    renderMeta();
  }

  function indent(node) {
    const sibs = WBS.siblings(S.plan.nodes, node.parentId);
    const i = sibs.findIndex((n) => n.id === node.id);
    if (i <= 0) { toast('已经是同级第一个，无法再缩进'); return; }
    const newParent = sibs[i - 1];
    WBS.moveNode(S.plan.nodes, node.id, newParent.id, 999);
    WBS.normalizeOrder(S.plan.nodes);
    S.expanded.add(newParent.id);
    recompute();
    scheduleSave();
    renderStage();
    renderInspector();
  }

  function outdent(node) {
    if (!node.parentId) { toast('已是一级工作项'); return; }
    const parent = byId(node.parentId);
    if (!parent) return;
    const grand = WBS.siblings(S.plan.nodes, parent.parentId);
    const idx = grand.findIndex((n) => n.id === parent.id);
    WBS.moveNode(S.plan.nodes, node.id, parent.parentId, idx + 1);
    WBS.normalizeOrder(S.plan.nodes);
    recompute();
    scheduleSave();
    renderStage();
    renderInspector();
  }

  function patchNode(node, patch) {
    Object.keys(patch).forEach((k) => { node[k] = patch[k]; });
    recompute();
    scheduleSave();
    renderMeta();
    renderStage();
  }

  /* ---------------------------------------------------------------- */
  /* 词典表                                                            */
  /* ---------------------------------------------------------------- */

  function renderTable(stage) {
    const c = WBS.compute(S.plan);
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'wbs');

    const cols = ['WBS', '工作项', '交付物', '验收标准', '责任部门', '责任人', '开始', '结束', '工期', '状态', '进度', '前置'];
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    cols.forEach((t) => htr.appendChild(el('th', '', t)));
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    c.nodes.forEach((node) => {
      const tr = document.createElement('tr');
      if (node.id === S.selId) tr.classList.add('sel');
      tr.dataset.id = node.id;
      tr.addEventListener('click', () => selectNode(node.id));

      const tdCode = el('td', 'c-code', node.code);
      tr.appendChild(tdCode);

      const tdTitle = el('td', 'c-title' + (node.level === 1 ? ' lv1' : ''));
      tdTitle.textContent = '　'.repeat(Math.max(0, node.level - 1)) + node.title;
      editable(tdTitle, node, 'title');
      tr.appendChild(tdTitle);

      const tdDel = el('td', '', node.deliverable || '');
      editable(tdDel, node, 'deliverable');
      tr.appendChild(tdDel);

      const tdAcc = el('td', '', node.acceptance || '');
      editable(tdAcc, node, 'acceptance');
      tr.appendChild(tdAcc);

      const tdDept = el('td', '', node.dept || '');
      editable(tdDept, node, 'dept');
      tr.appendChild(tdDept);

      const tdOwner = el('td', '', node.owner || '');
      editable(tdOwner, node, 'owner');
      tr.appendChild(tdOwner);

      tr.appendChild(el('td', 'c-num', node.startDate || '—'));
      tr.appendChild(el('td', 'c-num', node.endDate || '—'));
      tr.appendChild(el('td', 'c-num', node.duration || ''));

      const tdStatus = el('td', 'c-status');
      tdStatus.appendChild(el('span', 'wb-chip ' + node.status, WBS.STATUS_TEXT[node.status] || node.status));
      tr.appendChild(tdStatus);

      tr.appendChild(el('td', 'c-num', node.progress + '%'));

      const deps = node.deps.map((id) => (c.byId[id] ? c.byId[id].code : '')).filter(Boolean).join('、');
      tr.appendChild(el('td', 'c-muted', deps || ''));

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    stage.appendChild(wrap);
  }

  function editable(td, node, field) {
    td.setAttribute('contenteditable', 'plaintext-only');
    td.addEventListener('click', (e) => e.stopPropagation());
    td.addEventListener('focus', () => { td.dataset.old = node[field] || ''; });
    td.addEventListener('blur', () => {
      const v = td.textContent.replace(/^[　\s]+/, '').trim();
      if (v !== (node[field] || '')) {
        node[field] = v;
        scheduleSave();
        renderMeta();
        renderInspector();
      }
      td.textContent = field === 'title'
        ? '　'.repeat(Math.max(0, node.level - 1)) + (node[field] || '')
        : (node[field] || '');
    });
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
      if (e.key === 'Escape') { td.textContent = td.dataset.old || ''; td.blur(); }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 甘特图                                                            */
  /* ---------------------------------------------------------------- */

  function renderGantt(stage) {
    const ROW_H = 34, LEFT_W = 306, HEAD_H = 50;
    const c = WBS.compute(S.plan);
    const span = WBS.dateSpan(S.plan);
    const startD = new Date(WBS.parseDate(span.start).getTime() - 3 * DAY);
    const endD = new Date(WBS.parseDate(span.end).getTime() + 5 * DAY);
    const days = Math.max(14, WBS.dayDiff(startD, endD) + 1);
    const availW = Math.max(320, (stage.clientWidth || 900) - LEFT_W - 8);
    const dw = Math.min(26, Math.max(7, Math.floor(availW / days)));
    const trackW = days * dw;

    function addMonth(year, month, left, width) {
      if (width < 40) return;
      const label = width >= 120 ? (year + ' 年 ' + month + ' 月') : (month + ' 月');
      const md = el('div', 'g-month', label);
      md.style.left = left + 'px';
      md.style.width = width + 'px';
      months.appendChild(md);
    }

    const scroll = el('div', 'gantt-scroll');
    const inner = el('div', 'gantt-inner');
    inner.style.width = (LEFT_W + trackW) + 'px';

    /* 表头 */
    const head = el('div', 'g-head');
    const hl = el('div', 'g-left');
    hl.textContent = '工作项';
    head.appendChild(hl);
    const htrack = el('div', 'g-track');
    htrack.style.width = trackW + 'px';
    htrack.style.height = HEAD_H + 'px';

    const months = el('div', 'g-months');
    const dtrack = el('div', 'g-days');

    let curMonth = -1, curStart = 0;
    const step = dw >= 18 ? 1 : dw >= 11 ? 2 : dw >= 8 ? 5 : 7;
    for (let i = 0; i < days; i++) {
      const d = new Date(startD.getTime() + i * DAY);
      const m = d.getUTCFullYear() * 100 + d.getUTCMonth();
      if (m !== curMonth) {
        if (curMonth !== -1) {
          addMonth(Math.floor(curMonth / 100), (curMonth % 100) + 1, curStart * dw, (i - curStart) * dw);
        }
        curMonth = m;
        curStart = i;
      }
      const dd = el('div', 'g-day', (i % step === 0) ? String(d.getUTCDate()) : '');
      dd.style.left = (i * dw) + 'px';
      dd.style.width = dw + 'px';
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) dd.classList.add('weekend');
      if (WBS.fmtDate(d) === Z.bjDate()) dd.classList.add('today');
      dtrack.appendChild(dd);
    }
    if (curMonth !== -1) {
      addMonth(Math.floor(curMonth / 100), (curMonth % 100) + 1, curStart * dw, (days - curStart) * dw);
    }

    htrack.appendChild(months);
    htrack.appendChild(dtrack);
    head.appendChild(htrack);
    inner.appendChild(head);

    /* 行 */
    const body = el('div', 'g-body');
    const indexOf = {};
    c.nodes.forEach((n, i) => { indexOf[n.id] = i; });

    c.nodes.forEach((node) => {
      const row = el('div', 'g-row' + (node.id === S.selId ? ' sel' : ''));
      row.dataset.id = node.id;
      row.style.height = ROW_H + 'px';

      const left = el('div', 'g-left');
      left.style.setProperty('--depth', node.level - 1);
      left.appendChild(el('span', 'g-code', node.code));
      const t = el('span', 'g-title', node.title);
      t.title = node.title;
      left.appendChild(t);
      row.appendChild(left);

      const track = el('div', 'g-track');
      track.style.width = trackW + 'px';
      track.style.backgroundSize = dw + 'px 100%';

      if (node.startDate) {
        const off = WBS.dayDiff(startD, WBS.parseDate(node.startDate));
        const w = Math.max(6, (node.duration || 1) * dw - 2);
        const bar = el('div', 'g-bar' + (node.hasChildren ? ' branch' : '') + (node.progress >= 100 ? ' done' : ''));
        bar.style.left = (off * dw) + 'px';
        bar.style.width = w + 'px';
        bar.title = node.code + ' ' + node.title + '　' + node.startDate + ' ~ ' + node.endDate +
          '　进度 ' + node.progress + '%';
        if (node.progress > 0) {
          const fill = el('i');
          fill.style.width = node.progress + '%';
          bar.appendChild(fill);
        }
        track.appendChild(bar);
      } else {
        const bar = el('div', 'g-bar unscheduled');
        bar.style.left = '0px';
        bar.style.width = '76px';
        bar.title = '未排期';
        track.appendChild(bar);
      }

      row.appendChild(track);
      row.addEventListener('click', () => selectNode(node.id));
      body.appendChild(row);
    });
    inner.appendChild(body);

    /* 今日线 */
    const todayOff = WBS.dayDiff(startD, WBS.parseDate(Z.bjDate()));
    if (todayOff >= 0 && todayOff < days) {
      const line = el('div', 'g-today-line');
      line.style.left = (LEFT_W + todayOff * dw) + 'px';
      line.style.height = (body.children.length * ROW_H) + 'px';
      line.style.top = HEAD_H + 'px';
      inner.appendChild(line);
    }

    /* 依赖箭头 */
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'g-links');
    svg.setAttribute('width', trackW);
    svg.setAttribute('height', body.children.length * ROW_H);
    svg.style.left = LEFT_W + 'px';
    svg.style.top = HEAD_H + 'px';
    svg.innerHTML = '<defs><marker id="wbs-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0,0 L8,4 L0,8 z" style="fill:var(--w-link)"/></marker></defs>';

    c.nodes.forEach((node) => {
      if (!node.deps || !node.deps.length || !node.startDate) return;
      const i2 = indexOf[node.id];
      node.deps.forEach((depId) => {
        const dep = c.byId[depId];
        if (!dep || !dep.startDate) return;
        const i1 = indexOf[depId];
        if (i1 === undefined || i2 === undefined) return;
        const x1 = (WBS.dayDiff(startD, WBS.parseDate(dep.startDate)) + (dep.duration || 1)) * dw;
        const x2 = WBS.dayDiff(startD, WBS.parseDate(node.startDate)) * dw - 4;
        const y1 = i1 * ROW_H + ROW_H / 2;
        const y2 = i2 * ROW_H + ROW_H / 2;
        const mx = Math.max(x1 + 12, x2 - 12);
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', 'M' + x1 + ',' + y1 + ' H' + mx + ' V' + y2 + ' H' + x2);
        path.setAttribute('marker-end', 'url(#wbs-arrow)');
        svg.appendChild(path);
      });
    });
    inner.appendChild(svg);

    scroll.appendChild(inner);
    stage.appendChild(scroll);
  }

  /* ---------------------------------------------------------------- */
  /* 属性面板                                                          */
  /* ---------------------------------------------------------------- */

  function renderInspector() {
    const box = $('#inspector');
    box.innerHTML = '';
    if (S.mode === 'today') return;
    if (!S.plan) {
      box.innerHTML = '<div class="isp-empty"><b>未打开计划</b>从左侧选择一个计划，或新建一个。</div>';
      return;
    }

    const node = selected();

    const head = el('div', 'isp-head');
    head.appendChild(el('h3', '', node ? '工作项属性' : '计划属性'));
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.title = '收起面板';
    closeBtn.style.cssText = 'width:24px;height:24px;font-size:14px';
    closeBtn.addEventListener('click', () => {
      if (window.innerWidth <= 1280) document.body.classList.remove('isp-open');
      else document.body.classList.add('inspector-hidden');
    });
    head.appendChild(closeBtn);
    box.appendChild(head);

    const body = el('div', 'isp-body');
    box.appendChild(body);

    if (!node) return renderPlanInspector(body);
    return renderNodeInspector(body, node);
  }

  function field(label, input, hint) {
    const f = el('label', 'field');
    const s = el('span');
    s.appendChild(document.createTextNode(label));
    if (hint) {
      const i = el('i', '', hint);
      s.appendChild(i);
    }
    f.appendChild(s);
    f.appendChild(input);
    return f;
  }

  function textInput(value, placeholder, onInput) {
    const i = document.createElement('input');
    i.value = value || '';
    i.placeholder = placeholder || '';
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  function textArea(value, placeholder, rows, onInput) {
    const t = document.createElement('textarea');
    t.value = value || '';
    t.placeholder = placeholder || '';
    t.rows = rows || 3;
    t.addEventListener('input', () => onInput(t.value));
    return t;
  }

  function dateInput(value, onInput) {
    const i = document.createElement('input');
    i.type = 'date';
    i.value = value || '';
    i.addEventListener('change', () => onInput(i.value));
    return i;
  }

  function commit(patch) {
    const node = selected();
    if (!node) return;
    Object.keys(patch).forEach((k) => { node[k] = patch[k]; });
    recompute();
    scheduleSave();
    renderMeta();
    renderStage();
  }

  function setNodeDate(node, which, v) {
    if (which === 'start') {
      node.startDate = v;
      if (v && node.endDate) {
        node.duration = Math.max(1, WBS.dayDiff(WBS.parseDate(v), WBS.parseDate(node.endDate)) + 1);
      } else if (v) {
        node.endDate = WBS.addDaysStr(v, Math.max(1, node.duration || 1) - 1);
      }
    } else {
      node.endDate = v;
      if (v && node.startDate) {
        node.duration = Math.max(1, WBS.dayDiff(WBS.parseDate(node.startDate), WBS.parseDate(v)) + 1);
      } else if (v) {
        node.startDate = WBS.addDaysStr(v, -(Math.max(1, node.duration || 1) - 1));
      }
    }
    commit({});
    renderInspector();
  }

  function renderNodeInspector(body, node) {
    const info = el('div', 'isp-code');
    info.appendChild(el('span', 'code', node.code));
    info.appendChild(el('span', 'lvl', '第 ' + node.level + ' 层 · ' + (node.isLeaf ? '工作包' : '汇总项') + ' · ' + node.title.length + ' 字'));
    body.appendChild(info);

    const titleInput = textInput(node.title, '工作项名称', (v) => {
      node.title = v;
      scheduleSave();
      renderMeta();
    });
    titleInput.addEventListener('blur', () => { recompute(); renderStage(); renderMeta(); });
    body.appendChild(field('名称', titleInput));

    body.appendChild(field('交付物', textArea(node.deliverable, '完成后要交付什么（文档 / 页面 / 代码 / 结论）', 2,
      (v) => { node.deliverable = v; scheduleSave(); })));

    body.appendChild(field('验收标准', textArea(node.acceptance, '怎样算做完，越可检验越好', 2,
      (v) => { node.acceptance = v; scheduleSave(); })));

    const row1 = el('div', 'row2');
    row1.appendChild(field('责任人', textInput(node.owner, '姓名', (v) => { node.owner = v; scheduleSave(); renderStage(); })));
    row1.appendChild(field('责任部门', textInput(node.dept, '部门 / 小组', (v) => { node.dept = v; scheduleSave(); })));
    body.appendChild(row1);

    const row2 = el('div', 'row2');
    if (node.hasChildren) {
      const d1 = dateInput(node.startDate, null); d1.disabled = true;
      const d2 = dateInput(node.endDate, null); d2.disabled = true;
      row2.appendChild(field('开始（汇总）', d1));
      row2.appendChild(field('结束（汇总）', d2));
    } else {
      row2.appendChild(field('开始', dateInput(node.startDate, (v) => setNodeDate(node, 'start', v))));
      row2.appendChild(field('结束', dateInput(node.endDate, (v) => setNodeDate(node, 'end', v))));
    }
    body.appendChild(row2);

    const row3 = el('div', 'row2');
    const dur = document.createElement('input');
    dur.type = 'number';
    dur.min = '1';
    dur.value = node.duration || '';
    if (node.hasChildren) dur.disabled = true;
    else dur.addEventListener('change', () => {
      const d = Math.max(1, Number(dur.value) || 1);
      node.duration = d;
      if (node.startDate) node.endDate = WBS.addDaysStr(node.startDate, d - 1);
      commit({});
      renderInspector();
    });
    row3.appendChild(field('工期（天）', dur, node.hasChildren ? '由子项汇总' : ''));

    const statusSel = document.createElement('select');
    [['not_started', '未开始'], ['in_progress', '进行中'], ['done', '已完成'], ['blocked', '受阻']].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (node.status === v) o.selected = true;
      statusSel.appendChild(o);
    });
    if (node.hasChildren) statusSel.disabled = true;
    else statusSel.addEventListener('change', () => {
      const v = statusSel.value;
      commit({ status: v, progress: v === 'done' ? 100 : node.progress });
      renderInspector();
    });
    row3.appendChild(field('状态', statusSel, node.hasChildren ? '由子项汇总' : ''));
    body.appendChild(row3);

    /* 进度 */
    const progField = el('label', 'field');
    const pspan = el('span', '', '进度');
    if (node.hasChildren) pspan.appendChild(el('i', '', '按子项工期加权汇总'));
    progField.appendChild(pspan);
    const pr = el('div', 'range-row');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0'; range.max = '100'; range.step = '5';
    range.value = node.progress;
    range.disabled = !!node.hasChildren;
    const out = document.createElement('output');
    out.textContent = node.progress + '%';
    range.addEventListener('input', () => {
      out.textContent = range.value + '%';
      node.progress = Number(range.value);
      if (node.progress >= 100) node.status = 'done';
      else if (node.progress > 0 && node.status === 'not_started') node.status = 'in_progress';
      scheduleSave();
    });
    range.addEventListener('change', () => { recompute(); renderMeta(); renderStage(); renderInspector(); });
    pr.appendChild(range);
    pr.appendChild(out);
    progField.appendChild(pr);
    body.appendChild(progField);

    /* 依赖 */
    const sec = el('div', 'isp-section');
    sec.appendChild(el('h4', '', '前置工作项（完成-开始）'));
    const c = WBS.compute(S.plan);
    const depList = el('div', 'dep-list');
    node.deps.forEach((id) => {
      const d = c.byId[id];
      if (!d) return;
      const item = el('div', 'dep-item');
      item.appendChild(el('span', 'code', d.code));
      item.appendChild(el('span', '', d.title));
      const x = el('button', '', '×');
      x.addEventListener('click', () => {
        node.deps = node.deps.filter((v) => v !== id);
        commit({});
        renderInspector();
      });
      item.appendChild(x);
      depList.appendChild(item);
    });
    if (!node.deps.length) {
      const p = el('div', '', '暂无前置');
      p.style.cssText = 'font-size:11.5px;color:var(--w-faint)';
      depList.appendChild(p);
    }
    sec.appendChild(depList);

    const sel = document.createElement('select');
    const opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = '＋ 添加前置工作项…';
    sel.appendChild(opt0);
    c.nodes.forEach((n) => {
      if (n.id === node.id || node.deps.indexOf(n.id) >= 0) return;
      const o = document.createElement('option');
      o.value = n.id;
      o.textContent = n.code + '  ' + n.title;
      sel.appendChild(o);
    });
    sel.style.marginTop = '6px';
    sel.addEventListener('change', () => {
      const id = sel.value;
      if (!id) return;
      if (createsCycle(S.plan.nodes, node.id, id)) {
        toast('会形成循环依赖，已阻止', 'err');
        sel.value = '';
        return;
      }
      node.deps = node.deps.concat([id]);
      commit({});
      renderInspector();
    });
    sec.appendChild(sel);
    body.appendChild(sec);

    body.appendChild(field('备注', textArea(node.notes, '补充说明', 2, (v) => { node.notes = v; scheduleSave(); })));

    /* 操作 */
    if (!node.hasChildren) {
      const fsec = el('div', 'isp-section');
      fsec.appendChild(el('h4', '', '专注'));
      const kv = el('div', 'kv');
      kv.appendChild(el('span', '', '累计专注'));
      kv.appendChild(el('b', '', fmtMin(node.focusMin || 0)));
      fsec.appendChild(kv);
      const fb = el('button', 'wb-btn accent wb-focus-btn', '▶ 去专注');
      fb.title = '打开学习页，并把这次专注记到这一项';
      fb.addEventListener('click', () => goFocus({ kind: 'task', planId: S.plan.id, id: node.id }));
      fsec.appendChild(fb);
      body.appendChild(fsec);
    }

    const acts = el('div', 'isp-actions');
    const addB = el('button', 'wb-btn', '＋ 子项');
    addB.addEventListener('click', () => addChild(node.id, null, null));
    const aiB = el('button', 'wb-btn', 'AI 展开');
    aiB.addEventListener('click', () => aiExpand(node));
    acts.appendChild(addB);
    acts.appendChild(aiB);
    body.appendChild(acts);

    const acts2 = el('div', 'isp-actions');
    const dupB = el('button', 'wb-btn ghost', '复制');
    dupB.addEventListener('click', () => {
      const copy = WBS.cloneSubtree(S.plan.nodes, node.id);
      if (copy) {
        S.selId = copy.id;
        recompute();
        scheduleSave();
        renderStage();
        renderInspector();
        toast('已复制');
      }
    });
    const delB = el('button', 'wb-btn ghost', '删除');
    delB.style.color = 'var(--danger)';
    delB.addEventListener('click', () => removeNode(node));
    acts2.appendChild(dupB);
    acts2.appendChild(delB);
    body.appendChild(acts2);
  }

  function renderPlanInspector(body) {
    body.appendChild(field('计划名称', textInput(S.plan.title, '计划名称', (v) => {
      S.plan.title = v;
      document.title = v + ' · 计划拆解';
      scheduleSave();
      renderTopbar();
    })));

    body.appendChild(field('目标', textArea(S.plan.goal, '要达成的目标，越具体越好', 5, (v) => {
      S.plan.goal = v;
      scheduleSave();
      renderTopbar();
    })));

    body.appendChild(field('背景 / 约束', textArea(S.plan.background, '资源、预算、前置条件', 3, (v) => {
      S.plan.background = v;
      scheduleSave();
    })));

    const row = el('div', 'row2');
    row.appendChild(field('开始', dateInput(S.plan.startDate, (v) => { S.plan.startDate = v; scheduleSave(); renderMeta(); })));
    row.appendChild(field('目标完成', dateInput(S.plan.endDate, (v) => { S.plan.endDate = v; scheduleSave(); renderMeta(); })));
    body.appendChild(row);

    body.appendChild(field('负责人', textInput(S.plan.owner, '选填', (v) => { S.plan.owner = v; scheduleSave(); })));

    const sec = el('div', 'isp-section');
    sec.appendChild(el('h4', '', '概览'));
    const c = WBS.compute(S.plan);
    [['工作项总数', c.stats.total], ['叶子工作包', c.stats.leaves], ['已完成', c.stats.done],
      ['整体进度', c.stats.progress + '%'], ['最大层级', c.stats.maxDepth + ' 层']].forEach(([k, v]) => {
      const kv = el('div', 'kv');
      kv.appendChild(el('span', '', k));
      kv.appendChild(el('b', '', v));
      sec.appendChild(kv);
    });
    body.appendChild(sec);

    const acts = el('div', 'isp-actions');
    const ai = el('button', 'wb-btn accent', 'AI 拆解目标');
    ai.addEventListener('click', () => openAiDialog());
    const chk = el('button', 'wb-btn', '分解检查');
    chk.addEventListener('click', openCheck);
    acts.appendChild(ai);
    acts.appendChild(chk);
    body.appendChild(acts);

    const acts2 = el('div', 'isp-actions');
    const delP = el('button', 'wb-btn ghost', '删除这个计划');
    delP.style.color = 'var(--w-danger)';
    delP.addEventListener('click', async () => {
      const p = S.plan;
      if (!p) return;
      if (!(await confirmDialog('删除计划', '将删除「' + p.title + '」及其全部工作项（飞书里的对应记录也会删除），无法撤销。建议先导出 JSON 备份。', '删除'))) return;
      Z.deletePlan(p.id);
      S.plans = S.plans.filter((x) => x.id !== p.id);
      S.plan = null; S.order = []; S.dirty = false;
      showToday();
      toast('已删除');
    });
    acts2.appendChild(delP);
    body.appendChild(acts2);
  }

  function createsCycle(nodes, fromId, depId) {
    const map = {};
    nodes.forEach((n) => { map[n.id] = n; });
    const seen = new Set();
    function walk(id) {
      if (id === fromId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const n = map[id];
      if (!n) return false;
      return (n.deps || []).some(walk);
    }
    return walk(depId);
  }

  /* ---------------------------------------------------------------- */
  /* 分解检查                                                          */
  /* ---------------------------------------------------------------- */

  function openCheck() {
    if (!S.plan) return;
    const v = WBS.validate(S.plan);
    const box = $('#checkBody');
    box.innerHTML = '';
    if (!v.issues.length) {
      box.innerHTML = '<div class="isp-empty"><b>结构健康</b>没有发现明显问题：层级、交付物和责任人都是完整的。</div>';
    } else {
      v.issues.forEach((it) => {
        const d = el('div', 'issue ' + it.level);
        d.appendChild(el('span', 'issue-dot'));
        const txt = el('div');
        if (it.code) {
          const code = el('code', '', it.code);
          code.addEventListener('click', () => {
            $('#dlgCheck').close();
            S.selId = it.nodeId;
            const target = S.plan.nodes.filter((n) => n.id === it.nodeId)[0];
            if (target && target.parentId) {
              S.expanded.add(target.parentId);
              const grand = S.plan.nodes.filter((n) => n.id === target.parentId)[0];
              if (grand && grand.parentId) S.expanded.add(grand.parentId);
            }
            renderStage();
            renderInspector();
            const row = $('.trow[data-id="' + it.nodeId + '"]');
            if (row) row.scrollIntoView({ block: 'center' });
          });
          txt.appendChild(code);
        }
        txt.appendChild(document.createTextNode(it.text));
        d.appendChild(txt);
        box.appendChild(d);
      });
    }
    $('#dlgCheck').showModal();
  }

  /* ---------------------------------------------------------------- */
  /* AI 拆解                                                           */
  /* ---------------------------------------------------------------- */

  function openAiDialog() {
    if (!S.plan) return;
    $('#aiGoal').value = S.plan.goal || S.plan.title || '';
    $('#aiStart').value = S.plan.startDate || Z.bjDate();
    $('#aiEnd').value = S.plan.endDate || '';
    $('#aiTeam').value = '';
    $('#aiExtra').value = '';
    $('#aiResult').innerHTML = '<div class="ai-placeholder">拆解结果会显示在这里</div>';
    $('#aiSummary').textContent = '';
    $('#btnAiApply').disabled = true;
    S.aiDraft = null;

    const hint = $('#aiHint');
    if (!Z.hasToken() || !Z.endpoint()) {
      hint.innerHTML = '这台设备还<b>没有 AI 口令</b>（点右上角「退出」后重新输入密码即可）。也可以点「复制提示词」发给任意 AI，再用「粘贴结果」导入。';
    } else {
      hint.textContent = '由 DeepSeek 经私人中转生成，通常 20–60 秒。连不上时可用「复制提示词 / 粘贴结果」手动拆解。';
    }

    $('#dlgAi').showModal();
  }

  function setAiLoading(on, text) {
    const box = $('#aiResult');
    if (on) {
      box.innerHTML = '';
      const d = el('div', 'loading');
      d.appendChild(el('span', 'spinner'));
      d.appendChild(el('span', '', text || '正在按 WBS 结构拆解，通常需要 20-60 秒…'));
      box.appendChild(d);
    }
  }

  async function runAi() {
    const goal = $('#aiGoal').value.trim();
    if (!goal) { toast('请填写目标', 'err'); return; }
    $('#btnAiApply').disabled = true;
    setAiLoading(true);
    try {
      const startDate = $('#aiStart').value || Z.bjDate();
      const endDate = $('#aiEnd').value;
      if (endDate && endDate < startDate) throw new Error('截止日期早于开始日期，请先改一下日期');
      const data = await aiRequest({
        mode: 'decompose',
        goal: goal,
        startDate: startDate,
        endDate: endDate,
        team: $('#aiTeam').value,
        extra: deadlineExtra(startDate, endDate, $('#aiExtra').value),
        depth: Number($('#aiDepth').value)
      });
      const nodes = convertPaths(data.nodes || []);
      if (!nodes.length) throw new Error('模型返回的工作项为空');
      scheduleDraft(nodes, startDate);
      const fit = WBS.fitSchedule(nodes, startDate, endDate);
      const c = WBS.compute({ id: 'tmp', title: '', goal: '', nodes: nodes });
      S.aiDraft = { title: data.title || goal.slice(0, 20), summary: data.summary || '', nodes: nodes, stats: c.stats, startDate: startDate, endDate: endDate, fit: fit };
      renderAiPreview(S.aiDraft);
    } catch (e) {
      $('#aiResult').innerHTML = '<div class="ai-placeholder" style="color:var(--w-danger);line-height:1.8;padding:30px 16px;text-align:center">' +
        esc(e.message) + '</div>';
    }
  }

  function renderAiPreview(data) {
    const box = $('#aiResult');
    box.innerHTML = '';
    const nodes = data.nodes || [];
    const byCode = {};
    nodes.forEach((n) => { byCode[n.id] = n; });
    const depthOf = (n) => (n.code ? String(n.code).split('.').length : 1);

    nodes.forEach((n) => {
      const row = el('div', 'ai-preview-row' + (depthOf(n) === 1 ? ' lv1' : ''));
      row.style.setProperty('--depth', depthOf(n) - 1);
      row.appendChild(el('span', 'code', n.code || ''));
      row.appendChild(el('span', '', n.title));
      if (n.duration) row.appendChild(el('span', 'dur', (n.startDate ? fmtShort(n.startDate) + (n.endDate && n.endDate !== n.startDate ? '–' + fmtShort(n.endDate) : '') + ' · ' : '') + n.duration + ' 天'));
      box.appendChild(row);
    });

    const st = data.stats || {};
    $('#aiSummary').textContent = (data.summary ? data.summary + '　·　' : '') +
      '共 ' + (st.total || nodes.length) + ' 项，' + (st.maxDepth || 3) + ' 层' +
      (data.fit && fitText(data.fit) ? '　·　' + fitText(data.fit) : '');
    $('#aiSummary').classList.toggle('fit-note', !!(data.fit && data.fit.status === 'compressed'));
    $('#btnAiApply').disabled = !nodes.length;
  }

  async function applyAi() {
    if (!S.aiDraft) return;
    if (S.plan.nodes.length) {
      const ok = await confirmDialog('替换现有结构', '当前计划已有 ' + S.plan.nodes.length + ' 个工作项，采用 AI 结果会全部替换。', '替换');
      if (!ok) return;
    }
    S.plan.nodes = S.aiDraft.nodes;
    if (S.aiDraft.startDate) S.plan.startDate = S.aiDraft.startDate;
    if (S.aiDraft.endDate) S.plan.endDate = S.aiDraft.endDate;
    if (!S.plan.title || S.plan.title === '未命名计划') S.plan.title = S.aiDraft.title || S.plan.title;
    WBS.normalizeOrder(S.plan.nodes);
    S.selId = null;
    expandAll(true);
    recompute();
    scheduleSave();
    renderAll();
    $('#dlgAi').close();
    const ft = S.aiDraft.fit && S.aiDraft.fit.status === 'compressed' ? '（' + fitText(S.aiDraft.fit) + '）' : '';
    toast('已采用 AI 拆解结果' + ft, 'ok');
  }

  async function aiExpand(node) {
    if (!S.plan) return;
    const ok = await confirmDialog('AI 展开', '把「' + node.title + '」继续拆成 2-6 个子项并追加到它的下面。', '开始');
    if (!ok) return;
    aiBLoading(node);
    try {
      const c0 = WBS.compute(S.plan);
      const cur = c0.byId[node.id] || node;
      // 子项可用的时间窗：本项原有的起止（不超过计划截止日），否则用计划区间
      const winStart = cur.startDate || S.plan.startDate || Z.bjDate();
      let winEnd = cur.endDate && cur.endDate >= winStart ? cur.endDate : (S.plan.endDate || '');
      if (S.plan.endDate && winEnd && winEnd > S.plan.endDate) winEnd = S.plan.endDate;
      const windowDays = ZNPrompts.spanDays(winStart, winEnd);
      const data = await aiRequest({
        mode: 'expand',
        planTitle: S.plan.title,
        goal: S.plan.goal,
        nodeTitle: cur.title,
        nodeCode: cur.code,
        nodeDeliverable: (cur.deliverable || '') + (windowDays ? '（该项最多 ' + windowDays + ' 个自然日，子项工期之和不得超过 ' + windowDays + ' 天，可以是 1 天）' : ''),
        windowDays: windowDays
      });
      const kids = S.plan.nodes.filter((x) => x.parentId === node.id).length;
      let cursor = winStart;
      const list = (data.nodes || []).map((item, i) => {
        const d = Math.max(1, Math.min(60, Number(item.duration) || 3));
        const n = WBS.normalizeNode({
          id: WBS.uid('n'), parentId: node.id, title: item.title || ('子项 ' + (i + 1)),
          deliverable: item.deliverable || '', acceptance: item.acceptance || '', owner: item.owner || '',
          duration: d, startDate: cursor, endDate: WBS.addDaysStr(cursor, d - 1), order: kids + i
        });
        cursor = WBS.addDaysStr(n.endDate, 1);
        return n;
      });
      if (!list.length) throw new Error('模型没有返回子项');
      const fit = WBS.fitSchedule(list, winStart, winEnd);
      list.forEach((n) => S.plan.nodes.push(n));
      WBS.normalizeOrder(S.plan.nodes);
      S.expanded.add(node.id);
      recompute();
      scheduleSave();
      renderStage();
      renderInspector();
      renderMeta();
      toast('已追加 ' + list.length + ' 个子项' + (fit.status === 'compressed' ? '（' + fitText(fit) + '）' : ''), 'ok');
    } catch (e) {
      toast('展开失败：' + e.message, 'err');
    }
  }

  function aiBLoading(node) {
    toast('正在展开「' + node.title + '」…');
  }

  /* ---------------------------------------------------------------- */
  /* 粘贴解析                                                          */
  /* ---------------------------------------------------------------- */

  function parseDraft(text) {
    let obj;
    try {
      obj = JSON.parse(String(text).replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim());
    } catch (e) {
      throw new Error('不是合法的 JSON');
    }
    let nodes = obj.nodes;
    if (!nodes && obj.data && obj.data.nodes) nodes = obj.data.nodes;
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('没有找到 nodes 数组');

    if (nodes[0].path !== undefined) return convertPaths(nodes);

    if (nodes[0].parentId !== undefined) {
      return nodes.map((n, i) => WBS.normalizeNode(Object.assign({}, n, {
        id: n.id || WBS.uid('n'),
        order: n.order !== undefined ? n.order : i
      })));
    }

    // 只有标题的简单数组
    return nodes.map((n, i) => WBS.normalizeNode({
      id: WBS.uid('n'),
      parentId: null,
      title: typeof n === 'string' ? n : (n.title || ('工作项 ' + (i + 1))),
      duration: n.duration || 3,
      order: i
    }));
  }

  function convertPaths(list) {
    const byPath = {};
    const counts = {};
    const out = [];
    list.forEach((item, i) => {
      const raw = String(item.path || '').trim();
      const segs = raw ? raw.split('.').filter(Boolean) : [String(i + 1)];
      const path = segs.join('.');
      const parentPath = segs.length > 1 ? segs.slice(0, -1).join('.') : '';
      const parent = parentPath ? byPath[parentPath] : null;
      const key = parent ? parent.id : '';
      counts[key] = counts[key] || 0;
      const n = WBS.normalizeNode({
        id: WBS.uid('n'),
        parentId: parent ? parent.id : null,
        title: item.title || ('工作项 ' + (i + 1)),
        deliverable: item.deliverable || '',
        acceptance: item.acceptance || '',
        owner: item.owner || '',
        duration: Math.max(1, Number(item.duration) || 3),
        order: counts[key]++
      });
      byPath[path] = n;
      out.push(n);
    });
    return out;
  }

  function scheduleDraft(nodes, startDate) {
    let cursor = startDate || Z.bjDate();
    const kidsOf = {};
    nodes.forEach((n) => { (kidsOf[n.parentId || ''] = kidsOf[n.parentId || ''] || []).push(n); });
    Object.keys(kidsOf).forEach((k) => kidsOf[k].sort((a, b) => a.order - b.order));
    function walk(parentId) {
      (kidsOf[parentId] || []).forEach((n) => {
        if ((kidsOf[n.id] || []).length) walk(n.id);
        else {
          const d = Math.max(1, n.duration || 3);
          n.startDate = cursor;
          n.endDate = WBS.addDaysStr(cursor, d - 1);
          cursor = WBS.addDaysStr(n.endDate, 1);
        }
      });
    }
    (kidsOf[''] || []).forEach((r) => {
      walk(r.id);
      if (!(kidsOf[r.id] || []).length) {
        const d = Math.max(1, r.duration || 3);
        r.startDate = cursor;
        r.endDate = WBS.addDaysStr(cursor, d - 1);
        cursor = WBS.addDaysStr(r.endDate, 1);
      }
    });
    return nodes;
  }

  /* ---------------------------------------------------------------- */
  /* 导出                                                              */
  /* ---------------------------------------------------------------- */

  function safeName(s) {
    return String(s || 'plan').replace(/[\\\/\:\*\?\"\<\>\|]/g, '_').slice(0, 60);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function buildXlsx(plan) {
    const c = WBS.compute(JSON.parse(JSON.stringify(plan)));
    const rows = c.nodes.map((n) => [
      n.code, n.level, '　'.repeat(Math.max(0, n.level - 1)) + n.title,
      n.deliverable || '', n.acceptance || '', n.dept || '', n.owner || '',
      n.startDate || '', n.endDate || '', n.duration || '',
      WBS.STATUS_TEXT[n.status] || n.status, n.progress,
      n.deps.length ? n.deps.map((id) => (c.byId[id] ? c.byId[id].code : '')).filter(Boolean).join('、') : '',
      n.focusMin ? n.focusMin : '',
      n.notes || ''
    ]);
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    return WBSXLSX.build({
      sheetName: 'WBS 词典',
      title: plan.title + ' · WBS 工作分解',
      subtitle: '目标：' + (plan.goal || '—') + '　｜　共 ' + c.stats.total + ' 个工作项（' + c.stats.leaves + ' 个叶子）　｜　整体进度 ' + c.stats.progress + '%' + '　｜　导出时间 ' + stamp,
      headers: ['WBS 编码', '层级', '工作项名称', '交付物', '验收标准', '责任部门', '责任人', '开始日期', '结束日期', '工期(天)', '状态', '进度(%)', '前置工作项', '累计专注(分钟)', '备注'],
      widths: [11, 6, 34, 24, 30, 12, 10, 12, 12, 9, 9, 9, 12, 12, 24],
      centerCols: [0, 1, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      rows: rows,
      rowHeight: 22,
      footer: '内容由AI生成'
    });
  }

  function exportXlsx() {
    if (!S.plan) return;
    try {
      const bytes = buildXlsx(S.plan);
      downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), safeName(S.plan.title) + '-WBS.xlsx');
      toast('Excel 已生成', 'ok');
    } catch (e) { toast('生成 Excel 失败：' + e.message, 'err'); }
  }

  function exportJson() {
    if (!S.plan) return;
    downloadBlob(new Blob([JSON.stringify(Z.getPlan(S.plan.id) || S.plan, null, 2)], { type: 'application/json' }), safeName(S.plan.title) + '-WBS.json');
  }

  /* 全部计划 + 临时待办 → 一个备份文件（换设备 / 留底） */
  function exportBackup() {
    const data = { type: 'zn-plan-backup', version: 1, exportedAt: new Date().toISOString(), plans: Z.listPlans(), todos: Z.listTodos() };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), '计划拆解备份-' + Z.bjDate() + '.json');
    toast('已导出 ' + data.plans.length + ' 个计划', 'ok');
  }

  function importJsonFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('文件太大（超过 8MB）', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result || ''));
        let plans = [];
        let todos = [];
        if (obj && obj.type === 'zn-plan-backup') { plans = obj.plans || []; todos = obj.todos || []; }
        else if (Array.isArray(obj)) plans = obj;
        else if (obj && Array.isArray(obj.nodes)) plans = [obj];
        else if (obj && obj.data && Array.isArray(obj.data.nodes)) plans = [obj.data];
        else throw new Error('不是计划 JSON 或备份文件');
        const r = Z.importPlans(plans);
        const have = {};
        Z.listTodos().forEach((t) => { have[t.id] = 1; });
        let tAdded = 0;
        todos.forEach((t) => { if (t && t.title && !have[t.id]) { Z.saveTodo(t); tAdded++; } });
        loadPlans();
        renderAll();
        toast('导入完成：新增 ' + r.added + '，更新 ' + r.replaced + '，另存副本 ' + r.copied + '，跳过 ' + r.skipped + (tAdded ? '，待办 ' + tAdded : ''), 'ok');
      } catch (e) { toast('导入失败：' + e.message, 'err'); }
    };
    reader.readAsText(file, 'utf-8');
  }

  function copyJson() {
    if (!S.plan) return;
    const text = JSON.stringify(S.plan, null, 2);
    navigator.clipboard.writeText(text).then(() => toast('完整数据已复制', 'ok'))
      .catch(() => toast('复制失败，请手动导出 JSON', 'err'));
  }

  function printPlan() {
    if (!S.plan) return;
    const c = WBS.compute(S.plan);
    const rows = c.nodes.map((n) => {
      const st = WBS.STATUS_TEXT[n.status] || n.status;
      return '<tr><td class="c">' + esc(n.code) + '</td>' +
        '<td class="t" style="padding-left:' + (8 + (n.level - 1) * 16) + 'px">' + esc(n.title) + '</td>' +
        '<td>' + esc(n.deliverable || '') + '</td>' +
        '<td>' + esc(n.acceptance || '') + '</td>' +
        '<td>' + esc(n.owner || '') + '</td>' +
        '<td>' + esc(n.startDate || '') + '</td><td>' + esc(n.endDate || '') + '</td>' +
        '<td class="c">' + (n.duration || '') + '</td>' +
        '<td class="c">' + esc(st) + '</td><td class="c">' + n.progress + '%</td></tr>';
    }).join('');

    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(S.plan.title) + '</title>' +
      '<style>body{font-family:"Microsoft YaHei",sans-serif;color:#182230;padding:24px;font-size:12px}' +
      'h1{font-size:18px;margin:0 0 6px}p.goal{color:#53637a;margin:0 0 14px;font-size:12px;line-height:1.6}' +
      'table{width:100%;border-collapse:collapse}th,td{border:1px solid #d5dde7;padding:5px 7px;vertical-align:top;line-height:1.5}' +
      'th{background:#eef3f9;font-size:11px;text-align:left}td.c{text-align:center;white-space:nowrap}' +
      'td.t{font-weight:600}.foot{margin-top:10px;color:#808080;font-size:10px}' +
      '@page{size:A4 landscape;margin:12mm}</style></head><body>' +
      '<h1>' + esc(S.plan.title) + ' · WBS 工作分解</h1>' +
      '<p class="goal">目标：' + esc(S.plan.goal || '—') + '　｜　共 ' + c.stats.total + ' 项　｜　整体进度 ' + c.stats.progress + '%</p>' +
      '<table><thead><tr><th>WBS</th><th>工作项</th><th>交付物</th><th>验收标准</th><th>责任人</th><th>开始</th><th>结束</th><th>工期</th><th>状态</th><th>进度</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="foot">内容由AI生成</div></body></html>';

    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了新窗口，请允许弹出窗口后重试', 'err'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 400);
  }

  /* ---------------------------------------------------------------- */
  /* 弹窗绑定                                                          */
  /* ---------------------------------------------------------------- */

  function openPlanDialog() {
    const form = $('#formPlan');
    form.reset();
    form.elements.startDate.value = Z.bjDate();
    form.elements.withAi.checked = true;
    $('#dlgPlan').showModal();
    setTimeout(() => form.elements.title.focus(), 60);
  }

  async function submitPlan(e) {
    e.preventDefault();
    const form = $('#formPlan');
    const title = form.elements.title.value.trim();
    if (!title) { toast('请填写计划名称', 'err'); return; }
    const payload = {
      title: title,
      goal: form.elements.goal.value.trim(),
      startDate: form.elements.startDate.value,
      endDate: form.elements.endDate.value,
      owner: form.elements.owner.value.trim()
    };
    const withAi = form.elements.withAi.checked;
    $('#dlgPlan').close();
    try {
      await createPlan(payload);
      toast('计划已创建', 'ok');
      if (withAi) openAiDialog();
    } catch (err) {
      toast('创建失败：' + err.message, 'err');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  function bind() {
    $('#btnNewPlan').addEventListener('click', openPlanDialog);
    $('#btnEmptyNew') && $('#btnEmptyNew').addEventListener('click', openPlanDialog);
    $('#formPlan').addEventListener('submit', submitPlan);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => { importJsonFile(e.target.files && e.target.files[0]); e.target.value = ''; });
    $('#btnBackup').addEventListener('click', exportBackup);
    $('#syncPill').addEventListener('click', () => Z.sync());
    $('#btnRail').addEventListener('click', () => document.body.classList.toggle('rail-open'));
    $('#railScrim').addEventListener('click', () => document.body.classList.remove('rail-open'));
    window.addEventListener('zn-plan-status', (e) => renderSync(e.detail));
    window.addEventListener('zn-plan-remote', onRemoteChange);

    $('#btnAi').addEventListener('click', openAiDialog);
    $('#btnAiRun').addEventListener('click', runAi);
    $('#btnAiApply').addEventListener('click', applyAi);
    $('#btnAiPrompt').addEventListener('click', async () => {
      const goal = $('#aiGoal').value.trim();
      if (!goal) { toast('请先填写目标', 'err'); return; }
      try {
        const user = ZNPrompts.buildDecomposePrompt({
          goal: goal,
          startDate: $('#aiStart').value,
          endDate: $('#aiEnd').value,
          team: $('#aiTeam').value,
          extra: $('#aiExtra').value,
          depth: Number($('#aiDepth').value)
        });
        const text = '【系统要求】\n' + ZNPrompts.SYSTEM_PROMPT + '\n\n【任务】\n' + user;
        await navigator.clipboard.writeText(text);
        toast('提示词已复制，粘贴给任意 AI 即可', 'ok');
      } catch (e) { toast('复制失败：' + e.message, 'err'); }
    });
    $('#btnAiPaste').addEventListener('click', () => {
      $('#pasteBox').value = '';
      $('#dlgPaste').showModal();
      setTimeout(() => $('#pasteBox').focus(), 60);
    });

    $('#btnPasteParse').addEventListener('click', () => {
      try {
        const nodes = parseDraft($('#pasteBox').value);
        const pStart = $('#aiStart').value || Z.bjDate();
        scheduleDraft(nodes, pStart);
        const fit = WBS.fitSchedule(nodes, pStart, $('#aiEnd').value);
        const tmp = { id: 'tmp', title: '导入', goal: '', nodes: nodes };
        const c = WBS.compute(tmp);
        S.aiDraft = {
          title: $('#aiGoal').value.trim().slice(0, 20) || '导入的计划',
          summary: '从粘贴内容解析',
          nodes: nodes,
          stats: c.stats,
          startDate: pStart,
          endDate: $('#aiEnd').value,
          fit: fit
        };
        renderAiPreview(S.aiDraft);
        $('#dlgPaste').close();
        toast('解析成功，共 ' + nodes.length + ' 项', 'ok');
      } catch (e) {
        toast('解析失败：' + e.message, 'err');
      }
    });

    $('#btnAddRoot').addEventListener('click', () => addChild(null, null, { title: '新阶段' }));

    $('#btnIsp').addEventListener('click', () => {
      const b = document.body;
      if (window.innerWidth <= 1280) {
        if (b.classList.contains('isp-open')) b.classList.remove('isp-open');
        else { b.classList.add('isp-open'); b.classList.remove('inspector-hidden'); }
        if (b.classList.contains('isp-open')) renderInspector();
      } else if (b.classList.contains('inspector-hidden')) {
        b.classList.remove('inspector-hidden');
        renderInspector();
      } else {
        b.classList.add('inspector-hidden');
      }
    });

    $$('#viewSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        S.view = b.dataset.view;
        renderStage();
      });
    });

    const menu = $('#exportMenu');
    $('#btnExport').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      menu.classList.remove('open');
      if (act === 'xlsx') exportXlsx();
      if (act === 'json') exportJson();
      if (act === 'print') printPlan();
      if (act === 'copyjson') copyJson();
      if (act === 'backup') exportBackup();
      if (act === 'import') $('#importFile').click();
    });

    $('#planSearch').addEventListener('input', (e) => {
      S.search = e.target.value;
      renderRail();
    });

    const titleEl = $('#planTitle');
    titleEl.addEventListener('blur', () => {
      if (!S.plan) return;
      const v = titleEl.textContent.trim();
      if (v && v !== S.plan.title) {
        S.plan.title = v;
        document.title = v + ' · 计划拆解';
        scheduleSave();
        renderRail();
      } else {
        titleEl.textContent = S.plan.title;
      }
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    });

    $$('dialog').forEach((d) => {
      d.addEventListener('click', (e) => {
        if (e.target === d) d.close();
      });
      d.addEventListener('close', () => {
        $$('[data-close]', d).forEach(() => {});
      });
    });
    document.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('[data-close]');
      if (c) {
        const d = c.closest('dialog');
        if (d) d.close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNow();
      }
      if (e.key === 'Escape') {
        const open = $$('dialog[open]');
        if (!open.length && S.selId) {
          S.selId = null;
          renderStage();
          renderInspector();
        }
      }
    });

    window.addEventListener('pagehide', () => {
      if (S.dirty && S.plan) saveNow();
    });
  }

  /* ---------------------------------------------------------------- */
  /* 今日待办                                                          */
  /* ---------------------------------------------------------------- */

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  function todayLabel() {
    const d = Z.bjDate();
    const dt = new Date(d + 'T00:00:00Z');
    return (dt.getUTCMonth() + 1) + ' 月 ' + dt.getUTCDate() + ' 日 · 周' + WEEK[dt.getUTCDay()] + '（北京时间）';
  }
  function fmtMin(m) {
    m = Math.round(Number(m) || 0);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
  }

  async function showToday() {
    if (S.dirty) await saveNow();
    S.mode = 'today';
    S.selId = null;
    document.body.classList.remove('rail-open', 'isp-open');
    try { localStorage.setItem('wbs.lastView', 'today'); } catch (e) {}
    renderAll();
  }

  function goFocus(ref) {
    if (S.dirty) saveNow();
    const q = ref.kind === 'todo' ? 'todo=' + encodeURIComponent(ref.id) : 'task=' + encodeURIComponent(ref.planId + ':' + ref.id);
    const keep = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? (new URLSearchParams(location.search).get('feishu') || '') : '';
    location.href = '../study/?' + q + (keep ? '&feishu=' + encodeURIComponent(keep) : '');
  }

  function renderTodayMeta(bar) {
    const td = Z.today();
    const f = Z.todayFocus();
    function stat(value, label, cls) {
      const d = el('div', 'mstat' + (cls ? ' ' + cls : ''));
      d.appendChild(el('b', '', value));
      d.appendChild(el('span', '', label));
      return d;
    }
    bar.appendChild(stat((td.total ? Math.round(td.done / td.total * 100) : 0) + '%', '今日完成度'));
    bar.appendChild(el('div', 'mstat-sep'));
    bar.appendChild(stat(td.done + ' / ' + td.total, '已完成'));
    bar.appendChild(stat(td.overdue, '已逾期', td.overdue ? 'warn' : ''));
    bar.appendChild(el('div', 'mstat-sep'));
    bar.appendChild(stat(fmtMin(f.minutes), '今日已专注'));
  }

  function renderToday(stage) {
    stage.innerHTML = '';
    const td = Z.today();
    const f = Z.todayFocus();
    const wrap = el('div', 'today');

    /* 头部：完成度环 + 专注 */
    const hero = el('div', 'today-hero');
    const pct = td.total ? Math.round(td.done / td.total * 100) : 0;
    const ring = el('div', 'today-ring');
    ring.style.setProperty('--p', pct);
    ring.appendChild(el('b', '', pct + '%'));
    ring.appendChild(el('span', '', '完成度'));
    hero.appendChild(ring);
    const info = el('div', 'today-info');
    info.appendChild(el('p', 'today-kicker', todayLabel()));
    info.appendChild(el('h2', '', td.total ? ('今天有 ' + td.total + ' 件事，已完成 ' + td.done + ' 件') : '今天还没有安排'));
    const sub = el('p', 'today-sub');
    sub.textContent = '今日已专注 ' + fmtMin(f.minutes) + (td.overdue ? ' · 有 ' + td.overdue + ' 件已逾期' : '') + ' · 点「▶ 专注」去学习页计时，时长会记到这一项';
    info.appendChild(sub);
    hero.appendChild(info);
    wrap.appendChild(hero);

    /* 添加临时待办 */
    const form = el('form', 'today-add');
    const input = el('input');
    input.placeholder = '添加一条临时待办（不属于任何计划），回车保存';
    input.maxLength = 120;
    input.setAttribute('aria-label', '新的临时待办');
    const addBtn = el('button', 'wb-btn accent', '添加');
    addBtn.type = 'submit';
    form.appendChild(input);
    form.appendChild(addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      Z.saveTodo({ title: v, date: Z.bjDate(), order: td.total + 1 });
      input.value = '';
      renderAll();
      setTimeout(() => { const i = $('.today-add input'); if (i) i.focus(); }, 0);
    });
    wrap.appendChild(form);

    const overdue = td.items.filter((i) => i.overdue);
    const todays = td.items.filter((i) => !i.overdue);
    const order = overdue.concat(todays).map((i) => i.key);

    function move(key, dir) {
      const arr = order.slice();
      const i = arr.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      arr.splice(j, 0, arr.splice(i, 1)[0]);
      Z.reorder(arr);
      renderAll();
    }

    function row(it, idx) {
      const r = el('div', 'today-row' + (it.done ? ' done' : '') + (it.overdue ? ' overdue' : ''));
      r.dataset.key = it.key;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = it.done;
      cb.setAttribute('aria-label', (it.done ? '取消完成：' : '标记完成：') + it.title);
      cb.addEventListener('change', () => {
        Z.setDone(it.kind === 'todo' ? { kind: 'todo', id: it.id } : { kind: 'task', planId: it.planId, id: it.id }, cb.checked);
        if (S.plan && it.planId === S.plan.id) { const p = Z.getPlan(it.planId); if (p) S.plan = WBS.normalizePlan(p); }
        loadPlans();
        renderAll();
        if (cb.checked) toast('已完成：' + it.title, 'ok');
      });
      r.appendChild(cb);
      const main = el('div', 'today-main');
      const t = el('div', 'today-title', it.title);
      main.appendChild(t);
      const meta = el('div', 'today-meta');
      if (it.kind === 'task') {
        meta.appendChild(el('span', 'code', it.code));
        meta.appendChild(el('span', '', it.planTitle));
        meta.appendChild(el('span', it.overdue ? 'od' : '', it.overdue ? ('逾期 · 应在 ' + fmtShort(it.endDate) + ' 完成') : (fmtShort(it.startDate) + ' → ' + fmtShort(it.endDate))));
      } else {
        meta.appendChild(el('span', 'tag', '临时'));
        if (it.overdue) meta.appendChild(el('span', 'od', '逾期 · ' + fmtShort(it.date)));
      }
      if (it.focusMin) meta.appendChild(el('span', 'fm', '已专注 ' + fmtMin(it.focusMin)));
      main.appendChild(meta);
      r.appendChild(main);

      const acts = el('div', 'today-acts');
      const up = el('button', 'ib', '↑'); up.title = '上移'; up.disabled = idx === 0;
      up.addEventListener('click', () => move(it.key, -1));
      const dn = el('button', 'ib', '↓'); dn.title = '下移'; dn.disabled = idx === order.length - 1;
      dn.addEventListener('click', () => move(it.key, 1));
      acts.appendChild(up);
      acts.appendChild(dn);
      if (!it.done) {
        const fb = el('button', 'wb-btn accent sm', '▶ 专注');
        fb.title = '去学习页专注，时长记到这一项';
        fb.addEventListener('click', () => goFocus(it.kind === 'todo' ? { kind: 'todo', id: it.id } : { kind: 'task', planId: it.planId, id: it.id }));
        acts.appendChild(fb);
      }
      if (it.kind === 'task') {
        const ob = el('button', 'wb-btn ghost sm', '打开');
        ob.title = '在计划里查看';
        ob.addEventListener('click', async () => { await openPlan(it.planId); S.view = 'tree'; selectNode(it.id); });
        acts.appendChild(ob);
      } else {
        const db = el('button', 'ib del', '×');
        db.title = '删除这条待办';
        db.addEventListener('click', () => { Z.deleteTodo(it.id); renderAll(); });
        acts.appendChild(db);
      }
      r.appendChild(acts);
      return r;
    }

    let idx = 0;
    if (overdue.length) {
      const sec = el('section', 'today-sec od');
      sec.appendChild(el('h3', '', '已逾期 · ' + overdue.length));
      overdue.forEach((it) => sec.appendChild(row(it, idx++)));
      wrap.appendChild(sec);
    }
    const sec2 = el('section', 'today-sec');
    sec2.appendChild(el('h3', '', '今天 · ' + todays.length));
    if (!todays.length) {
      const e = el('div', 'today-empty');
      e.innerHTML = '<b>今天没有排期中的工作包</b>给计划里的工作项排上日期（开始 ≤ 今天 ≤ 结束），它就会自动出现在这里；也可以在上面添加临时待办。';
      sec2.appendChild(e);
    }
    todays.forEach((it) => sec2.appendChild(row(it, idx++)));
    wrap.appendChild(sec2);

    stage.appendChild(wrap);
  }

  function renderSync(st) {
    const pill = $('#syncPill');
    if (!pill || !st) return;
    const map = { synced: '已同步', syncing: '同步中…', offline: '离线', error: '同步失败', local: '仅本机', idle: '未同步' };
    pill.dataset.state = st.status;
    let text = map[st.status] || st.status;
    if (st.status === 'synced' && st.lastSync) {
      // 统一按北京时间显示，与「今天」的划分一致
      const t = Date.parse(st.lastSync);
      if (!isNaN(t)) text += ' ' + new Date(t + 8 * 3600000).toISOString().slice(11, 16);
    }
    pill.querySelector('span').textContent = text;
    pill.title = (st.message || '') + '（点一下立即同步）';
    if (S.mode === 'today' && st.status === 'synced') { renderMeta(); }
  }

  function onRemoteChange() {
    S.plans = Z.listPlans().map(summarize);
    if (S.plan && !S.dirty && !S.saving) {
      const p = Z.getPlan(S.plan.id);
      if (p) {
        const sel = S.selId;
        S.plan = WBS.normalizePlan(p);
        S.plan.id = p.id;
        if (sel && !byId(sel)) S.selId = null;
      } else if (S.mode === 'plan') {
        S.plan = null;
        S.mode = 'today';
      }
    }
    const active = document.activeElement;
    const editing = active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) && !active.closest('.today-add');
    if (editing) { renderRail(); renderMeta(); return; }
    renderAll();
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  async function init() {
    bind();
    document.body.classList.remove('inspector-hidden');
    await loadPlans();
    const params = new URLSearchParams(location.search);
    const want = params.get('plan');
    if (want && Z.getPlan(want)) await openPlan(want);
    else { S.mode = 'today'; renderAll(); }
    renderSync(Z.state());
    Z.sync();
  }

  init();
})();
