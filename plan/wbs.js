/*
 * WBS 核心算法 —— 服务端与浏览器共用（UMD）
 * 来源：计划拆解/lib/wbs.js；壮尼Ni 网站版在 normalizeNode 里多保留 focusMin / todayOrder / doneDate 三个字段
 * 职责：编号生成、层级汇总、树/扁平视图、结构校验、节点移动
 */
(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.WBS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;

  function uid(prefix) {
    return (prefix || 'n') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  function clamp(v, lo, hi) {
    v = num(v, lo);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(d) {
    if (!d) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function dayDiff(a, b) {
    if (!a || !b) return 0;
    return Math.round((b.getTime() - a.getTime()) / DAY);
  }

  function addDaysStr(s, n) {
    var d = parseDate(s);
    if (!d) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return fmtDate(d);
  }

  function today() {
    var d = new Date();
    return fmtDate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
  }

  /* ---------- 节点规范化 ---------- */

  function normalizeNode(n, i) {
    var o = {
      id: n.id || uid('n'),
      parentId: typeof n.parentId === 'string' ? n.parentId : null,
      title: String(n.title || '').trim() || '未命名工作项',
      deliverable: String(n.deliverable || '').trim(),
      acceptance: String(n.acceptance || '').trim(),
      owner: String(n.owner || '').trim(),
      dept: String(n.dept || '').trim(),
      startDate: n.startDate || '',
      endDate: n.endDate || '',
      duration: Math.max(0, num(n.duration, 0)),
      status: ['not_started', 'in_progress', 'done', 'blocked'].indexOf(n.status) >= 0 ? n.status : 'not_started',
      progress: clamp(n.progress, 0, 100),
      deps: Array.isArray(n.deps) ? n.deps.filter(function (x) { return typeof x === 'string'; }) : [],
      notes: String(n.notes || ''),
      order: num(n.order, i),
      // 壮尼Ni 网站版新增：今日待办 / 学习联动
      focusMin: Math.max(0, Math.round(num(n.focusMin, 0) * 10) / 10),
      todayOrder: num(n.todayOrder, 0),
      doneDate: /^\d{4}-\d{2}-\d{2}$/.test(String(n.doneDate || '')) ? String(n.doneDate) : ''
    };
    return o;
  }

  function normalizePlan(plan) {
    var p = plan || {};
    var nodes = Array.isArray(p.nodes) ? p.nodes.map(normalizeNode) : [];
    return {
      id: p.id || uid('p'),
      title: String(p.title || '未命名计划').trim(),
      goal: String(p.goal || '').trim(),
      background: String(p.background || ''),
      owner: String(p.owner || ''),
      startDate: p.startDate || '',
      endDate: p.endDate || '',
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || new Date().toISOString(),
      nodes: nodes
    };
  }

  /* ---------- 计算 ---------- */

  function compute(plan) {
    var src = plan.nodes || [];
    var byId = {};
    var childrenOf = Object.create(null);

    src.forEach(function (n) {
      byId[n.id] = n;
      var key = n.parentId || '';
      (childrenOf[key] = childrenOf[key] || []).push(n);
    });

    var order = [];
    var depthOf = {};

    function walk(parentId, depth, prefix) {
      var kids = (childrenOf[parentId] || []).slice().sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      kids.forEach(function (n, i) {
        n.level = depth + 1;
        n.code = prefix ? prefix + '.' + (i + 1) : String(i + 1);
        n.hasChildren = !!(childrenOf[n.id] && childrenOf[n.id].length);
        n.isLeaf = !n.hasChildren;
        depthOf[n.id] = depth + 1;
        order.push(n);
        if (n.hasChildren) walk(n.id, depth + 1, n.code);
      });
    }
    walk('', 0, '');

    function rollup(n) {
      var kids = childrenOf[n.id] || [];
      if (!kids.length) {
        n.isLeaf = true;
        if (!n.duration) {
          var s = parseDate(n.startDate), e = parseDate(n.endDate);
          n.duration = (s && e) ? Math.max(1, dayDiff(s, e) + 1) : 1;
        }
        if (n.status === 'done' && n.progress < 100) n.progress = 100;
        if (n.progress >= 100 && n.status !== 'done') n.progress = 100;
        return n;
      }

      var totalW = 0, acc = 0, starts = [], ends = [];
      kids.forEach(function (k) {
        rollup(k);
        var w = Math.max(1, num(k.duration, 1));
        totalW += w;
        acc += clamp(k.progress, 0, 100) * w;
        var ks = parseDate(k.startDate), ke = parseDate(k.endDate);
        if (ks) starts.push(ks);
        if (ke) ends.push(ke);
      });

      n.isLeaf = false;
      n.progress = totalW ? Math.round(acc / totalW) : 0;
      if (starts.length) n.startDate = fmtDate(new Date(Math.min.apply(null, starts)));
      if (ends.length) n.endDate = fmtDate(new Date(Math.max.apply(null, ends)));
      var s2 = parseDate(n.startDate), e2 = parseDate(n.endDate);
      n.duration = (s2 && e2) ? Math.max(1, dayDiff(s2, e2) + 1) : totalW;

      var doneCount = kids.filter(function (k) { return k.status === 'done' || k.progress >= 100; }).length;
      var blocked = kids.some(function (k) { return k.status === 'blocked'; });
      var started = kids.some(function (k) { return k.status !== 'not_started' || k.progress > 0; });
      if (doneCount === kids.length) n.status = 'done';
      else if (blocked) n.status = 'blocked';
      else if (started) n.status = 'in_progress';
      else n.status = 'not_started';

      return n;
    }

    var roots = (childrenOf[''] || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    roots.forEach(rollup);

    var totalW2 = 0, acc2 = 0;
    roots.forEach(function (r) {
      var w = Math.max(1, num(r.duration, 1));
      totalW2 += w;
      acc2 += clamp(r.progress, 0, 100) * w;
    });

    var maxDepth = order.reduce(function (m, n) { return Math.max(m, n.level); }, 0);

    return {
      nodes: order,
      byId: byId,
      childrenOf: childrenOf,
      roots: roots,
      stats: {
        total: order.length,
        leaves: order.filter(function (n) { return n.isLeaf; }).length,
        done: order.filter(function (n) { return n.isLeaf && (n.status === 'done' || n.progress >= 100); }).length,
        progress: totalW2 ? Math.round(acc2 / totalW2) : 0,
        maxDepth: maxDepth
      }
    };
  }

  function tree(plan) {
    var c = compute(plan);
    function build(parentId) {
      return (c.childrenOf[parentId] || [])
        .slice()
        .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
        .map(function (n) {
          var o = {};
          for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) o[k] = n[k];
          o.children = build(n.id);
          return o;
        });
    }
    return build('');
  }

  function flat(plan) {
    return compute(plan).nodes.map(function (n) {
      return {
        code: n.code,
        level: n.level,
        title: n.title,
        deliverable: n.deliverable,
        acceptance: n.acceptance,
        owner: n.owner,
        dept: n.dept,
        startDate: n.startDate,
        endDate: n.endDate,
        duration: n.duration,
        status: n.status,
        progress: n.progress,
        deps: n.deps,
        notes: n.notes,
        id: n.id,
        parentId: n.parentId
      };
    });
  }

  /* ---------- 结构校验 ---------- */

  var STATUS_TEXT = {
    not_started: '未开始',
    in_progress: '进行中',
    done: '已完成',
    blocked: '受阻'
  };

  function validate(plan) {
    var c = compute(plan);
    var issues = [];
    var titleMap = {};

    c.nodes.forEach(function (n) {
      var key = (n.parentId || '') + '|' + n.title;
      if (titleMap[key]) {
        issues.push({ nodeId: n.id, code: n.code, level: 'warn', text: '同级存在同名工作项，容易混淆' });
      }
      titleMap[key] = true;

      if (n.isLeaf) {
        if (!n.deliverable) issues.push({ nodeId: n.id, code: n.code, level: 'warn', text: '叶子节点缺少交付物' });
        if (!n.owner) issues.push({ nodeId: n.id, code: n.code, level: 'info', text: '未指定责任人' });
        if (!n.startDate || !n.endDate) issues.push({ nodeId: n.id, code: n.code, level: 'info', text: '未设置起止日期' });
      } else {
        var kids = c.childrenOf[n.id] || [];
        if (kids.length === 1) issues.push({ nodeId: n.id, code: n.code, level: 'info', text: '只有 1 个子项，可考虑并入上级' });
      }
      if (n.level >= 4) issues.push({ nodeId: n.id, code: n.code, level: 'info', text: '层级已达 ' + n.level + ' 层，注意 WBS 通常不超过 4 层' });
    });

    if (!c.nodes.length) issues.push({ nodeId: null, code: '', level: 'warn', text: '计划还没有任何工作项' });

    // 排期是否超出计划截止日
    var info = scheduleInfo(plan);
    if (info.overDays > 0) {
      issues.unshift({ nodeId: info.lastLeafId, code: info.lastLeafCode || '', level: 'warn',
        text: '整体排期超出截止日 ' + info.overDays + ' 天：最晚 ' + info.lastEnd + ' 结束，截止 ' + plan.endDate +
          '。可点顶部「压缩到截止日」按比例压回计划区间' });
    }
    if (info.unscheduled > 0 && c.nodes.length) {
      issues.push({ nodeId: null, code: '', level: 'info', text: '有 ' + info.unscheduled + ' 个工作包还没排期，可点顶部「自动排期」按截止日排好' });
    }

    return { issues: issues, stats: c.stats };
  }

  /* ---------- 截止日约束排期 ---------- */

  /** 叶子节点（按树的先后顺序）。nodes 可以是子集：父级不在集合里的节点视为根 */
  function leafOrder(nodes) {
    var ids = {}, kids = {};
    nodes.forEach(function (n) { ids[n.id] = 1; });
    nodes.forEach(function (n) {
      var k = n.parentId && ids[n.parentId] ? n.parentId : '';
      (kids[k] = kids[k] || []).push(n);
    });
    Object.keys(kids).forEach(function (k) { kids[k].sort(function (a, b) { return (a.order || 0) - (b.order || 0); }); });
    var out = [];
    (function walk(pid) {
      (kids[pid] || []).forEach(function (n) {
        if ((kids[n.id] || []).length) walk(n.id); else out.push(n);
      });
    })('');
    return { leaves: out, kids: kids };
  }

  /** 父节点日期 / 工期 = 子项汇总（就地修改） */
  function rollupDates(nodes) {
    var lo = leafOrder(nodes), kids = lo.kids;
    (function up(pid) {
      var s = null, e = null;
      (kids[pid] || []).forEach(function (n) {
        var r = (kids[n.id] || []).length ? up(n.id) : { s: parseDate(n.startDate), e: parseDate(n.endDate) };
        if ((kids[n.id] || []).length && r.s && r.e) {
          n.startDate = fmtDate(r.s); n.endDate = fmtDate(r.e); n.duration = dayDiff(r.s, r.e) + 1;
        }
        if (r.s && (!s || r.s < s)) s = r.s;
        if (r.e && (!e || r.e > e)) e = r.e;
      });
      return { s: s, e: e };
    })('');
  }

  /** 当前排期与截止日的关系：最晚结束、超出天数、未排期叶子数 */
  function scheduleInfo(plan) {
    var lo = leafOrder(plan.nodes || []);
    var last = null, lastLeaf = null, unscheduled = 0, first = null;
    lo.leaves.forEach(function (n) {
      var s = parseDate(n.startDate), e = parseDate(n.endDate);
      if (!s || !e) { unscheduled++; return; }
      if (!last || e > last) { last = e; lastLeaf = n; }
      if (!first || s < first) first = s;
    });
    var end = parseDate(plan.endDate), start = parseDate(plan.startDate) || first;
    var codeOf = '';
    if (lastLeaf) { var c = compute(plan); codeOf = c.byId[lastLeaf.id] ? c.byId[lastLeaf.id].code : ''; }
    return {
      lastEnd: last ? fmtDate(last) : '',
      lastLeafId: lastLeaf ? lastLeaf.id : null,
      lastLeafCode: codeOf,
      spanDays: first && last ? dayDiff(start && start < first ? start : first, last) + 1 : 0,
      windowDays: start && end && end >= start ? dayDiff(start, end) + 1 : 0,
      overDays: last && end && last > end ? dayDiff(end, last) : 0,
      unscheduled: unscheduled
    };
  }

  /**
   * 把叶子排期约束到 [startDate, endDate]（含首尾，自然日）。
   * - fillMissing：没有日期的叶子按工期接在已排期的后面（没有已排期的就从开始日起串行）
   * - 超出截止日时按比例压缩：保持先后顺序（前一项结束 ≤ 后一项开始），允许并行 / 同一天多项，每项至少 1 天
   * 就地修改 nodes（叶子和父级的 startDate / endDate / duration），返回说明。
   */
  function fitSchedule(nodes, startDate, endDate, opts) {
    opts = opts || {};
    var lo = leafOrder(nodes);
    var leaves = lo.leaves;
    var start = parseDate(startDate);
    var filled = 0;
    if (opts.fillMissing) {
      var cursor = null;
      leaves.forEach(function (n) {
        var s = parseDate(n.startDate), e = parseDate(n.endDate);
        if (s && e && (!cursor || e >= cursor)) cursor = new Date(e.getTime() + DAY);
      });
      if (!cursor) cursor = start || parseDate(opts.today || today());
      leaves.forEach(function (n) {
        if (parseDate(n.startDate) && parseDate(n.endDate)) return;
        var d = Math.max(1, Math.round(num(n.duration, 1)) || 1);
        n.startDate = fmtDate(cursor);
        n.endDate = fmtDate(new Date(cursor.getTime() + (d - 1) * DAY));
        n.duration = d;
        cursor = new Date(cursor.getTime() + d * DAY);
        filled++;
      });
    }
    var dated = leaves.filter(function (n) { return parseDate(n.startDate) && parseDate(n.endDate); });
    var res = { status: 'empty', filled: filled, beforeDays: 0, afterDays: 0, overDays: 0, lastEnd: '' };
    if (!dated.length) { rollupDates(nodes); return res; }
    var minS = null, maxE = null;
    dated.forEach(function (n) {
      var s = parseDate(n.startDate), e = parseDate(n.endDate);
      if (e < s) { n.endDate = n.startDate; e = s; }
      if (!minS || s < minS) minS = s;
      if (!maxE || e > maxE) maxE = e;
    });
    if (!start) start = minS;
    var origin = minS < start ? minS : start;
    res.beforeDays = dayDiff(origin, maxE) + 1;
    res.lastEnd = fmtDate(maxE);
    var end = parseDate(endDate);
    if (!end) { res.status = 'nodeadline'; res.afterDays = res.beforeDays; rollupDates(nodes); return res; }
    if (end < start) { res.status = 'baddeadline'; rollupDates(nodes); return res; }
    var W = dayDiff(start, end) + 1;
    res.windowDays = W;
    if (maxE <= end) { res.status = 'ok'; res.afterDays = res.beforeDays; rollupDates(nodes); return res; }
    if (opts.compress === false) { res.status = 'over'; res.overDays = dayDiff(end, maxE); rollupDates(nodes); return res; }
    var T = res.beforeDays;
    var f = W / T;
    var eps = 1e-9;
    var newMax = null;
    dated.forEach(function (n) {
      var s = dayDiff(origin, parseDate(n.startDate));
      var e = dayDiff(origin, parseDate(n.endDate)) + 1;
      var ns = Math.floor(s * f + eps);
      var ne = Math.max(ns, Math.ceil(e * f - eps) - 1);
      if (ne > W - 1) ne = W - 1;
      if (ns > ne) ns = ne;
      n.startDate = fmtDate(new Date(start.getTime() + ns * DAY));
      n.endDate = fmtDate(new Date(start.getTime() + ne * DAY));
      n.duration = ne - ns + 1;
      if (newMax === null || ne > newMax) newMax = ne;
    });
    rollupDates(nodes);
    res.status = 'compressed';
    res.afterDays = newMax + 1;
    res.lastEnd = fmtDate(new Date(start.getTime() + newMax * DAY));
    return res;
  }

  /* ---------- 结构操作 ---------- */

  function siblings(nodes, parentId) {
    return nodes.filter(function (n) { return (n.parentId || null) === (parentId || null); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }

  function normalizeOrder(nodes) {
    var groups = Object.create(null);
    nodes.forEach(function (n) {
      var k = n.parentId || '';
      (groups[k] = groups[k] || []).push(n);
    });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
        .forEach(function (n, i) { n.order = i; });
    });
    return nodes;
  }

  function descendants(nodes, id) {
    var out = [];
    var stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      nodes.forEach(function (n) {
        if (n.parentId === cur) { out.push(n.id); stack.push(n.id); }
      });
    }
    return out;
  }

  function moveNode(nodes, id, parentId, index) {
    var node = nodes.filter(function (n) { return n.id === id; })[0];
    if (!node) return nodes;
    if (parentId === id) return nodes;
    if (descendants(nodes, id).indexOf(parentId) >= 0) return nodes;

    var oldParent = node.parentId || null;
    node.parentId = parentId || null;

    var target = siblings(nodes, parentId).filter(function (n) { return n.id !== id; });
    var pos = typeof index === 'number' ? Math.max(0, Math.min(index, target.length)) : target.length;
    target.splice(pos, 0, node);
    target.forEach(function (n, i) { n.order = i; });

    if (oldParent !== (parentId || null)) normalizeOrder(nodes);
    return nodes;
  }

  function removeNode(nodes, id) {
    var kill = descendants(nodes, id).concat([id]);
    return nodes.filter(function (n) { return kill.indexOf(n.id) < 0; });
  }

  function addNode(nodes, parentId, afterId, init) {
    var sibs = siblings(nodes, parentId);
    var node = normalizeNode(Object.assign({
      id: uid('n'),
      parentId: parentId || null,
      title: '新工作项',
      order: sibs.length
    }, init || {}));
    if (afterId) {
      var idx = sibs.findIndex(function (n) { return n.id === afterId; });
      if (idx >= 0) {
        sibs.splice(idx + 1, 0, node);
        sibs.forEach(function (n, i) { n.order = i; });
        nodes.push(node);
        return node;
      }
    }
    sibs.push(node);
    sibs.forEach(function (n, i) { n.order = i; });
    nodes.push(node);
    return node;
  }

  function cloneSubtree(nodes, id) {
    var node = nodes.filter(function (n) { return n.id === id; })[0];
    if (!node) return null;
    var map = {};
    var subs = descendants(nodes, id);
    var all = [node].concat(nodes.filter(function (n) { return subs.indexOf(n.id) >= 0; }));

    all.forEach(function (n) {
      map[n.id] = normalizeNode(Object.assign({}, n, {
        id: uid('n'),
        title: n.id === id ? n.title + '（副本）' : n.title,
        order: n.id === id ? (n.order || 0) + 0.5 : n.order
      }));
    });

    var copies = all.map(function (n) {
      var c = map[n.id];
      if (n.id !== id) c.parentId = map[n.parentId] ? map[n.parentId].id : null;
      return c;
    });

    copies.forEach(function (c) { nodes.push(c); });
    normalizeOrder(nodes);
    return map[id];
  }

  /* ---------- 其他 ---------- */

  function dateSpan(plan) {
    var c = compute(plan);
    var starts = [], ends = [];
    c.nodes.forEach(function (n) {
      var s = parseDate(n.startDate), e = parseDate(n.endDate);
      if (s) starts.push(s);
      if (e) ends.push(e);
    });
    var s0 = parseDate(plan.startDate), e0 = parseDate(plan.endDate);
    if (s0) starts.push(s0);
    if (e0) ends.push(e0);
    if (!starts.length || !ends.length) {
      var t = parseDate(today());
      return { start: fmtDate(t), end: fmtDate(new Date(t.getTime() + 30 * DAY)) };
    }
    return {
      start: fmtDate(new Date(Math.min.apply(null, starts))),
      end: fmtDate(new Date(Math.max.apply(null, ends)))
    };
  }

  function shiftPlan(plan, baseStart) {
    var base = parseDate(baseStart);
    if (!base) return plan;
    var c = compute(plan);
    var first = null;
    c.nodes.forEach(function (n) {
      var s = parseDate(n.startDate);
      if (s && (!first || s < first)) first = s;
    });
    if (!first) return plan;
    var delta = dayDiff(first, base);
    if (!delta) return plan;
    c.nodes.forEach(function (n) {
      if (n.startDate) n.startDate = addDaysStr(n.startDate, delta);
      if (n.endDate) n.endDate = addDaysStr(n.endDate, delta);
    });
    if (plan.startDate) plan.startDate = addDaysStr(plan.startDate, delta);
    if (plan.endDate) plan.endDate = addDaysStr(plan.endDate, delta);
    return plan;
  }

  return {
    uid: uid,
    today: today,
    parseDate: parseDate,
    fmtDate: fmtDate,
    dayDiff: dayDiff,
    addDaysStr: addDaysStr,
    normalizeNode: normalizeNode,
    normalizePlan: normalizePlan,
    normalizeOrder: normalizeOrder,
    compute: compute,
    tree: tree,
    flat: flat,
    validate: validate,
    descendants: descendants,
    moveNode: moveNode,
    removeNode: removeNode,
    addNode: addNode,
    cloneSubtree: cloneSubtree,
    siblings: siblings,
    dateSpan: dateSpan,
    leafOrder: leafOrder,
    rollupDates: rollupDates,
    scheduleInfo: scheduleInfo,
    fitSchedule: fitSchedule,
    shiftPlan: shiftPlan,
    STATUS_TEXT: STATUS_TEXT
  };
});
