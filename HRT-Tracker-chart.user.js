// ==UserScript==
// @name         HRT Tracker · 曲线显示与缩放
// @namespace    whatasiger.hrt.curves
// @version      1.2.0
// @description  CPA 曲线开关、只显示个体化模型开关；横纵轴无极缩放，放大后横轴显示小时。支持移动端。
// @match        https://hrt.transmtf.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';

  const ID = 'hrt-curve-switches-v1';
  const STORAGE = 'whatasiger.hrt.curve-visibility.v1';
  if (document.getElementById(ID + '-style')) return;

  // 只认 true，其余一律按默认值处理
  const parse = raw => {
    try {
      const s = JSON.parse(raw || '{}');
      return { hideCPA: s.hideCPA === true, personalOnly: s.personalOnly === true };
    } catch {
      return { hideCPA: false, personalOnly: false };
    }
  };

  let prefs;
  try { prefs = parse(localStorage.getItem(STORAGE)); }
  catch { prefs = parse(null); }

  const style = document.createElement('style');
  style.id = ID + '-style';
  style.textContent = `
    [data-hrt-curve-hidden="1"] { display: none !important; }
    .hrt-curve-controls {
      display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px;
      margin-left: auto; max-width: 100%; box-sizing: border-box;
    }
    .hrt-curve-controls button {
      appearance: none; -webkit-appearance: none; cursor: pointer; touch-action: manipulation;
      font: inherit; font-size: 12px; line-height: 1.4; font-weight: 600;
      padding: 7px 10px; border-radius: 9px; box-sizing: border-box; white-space: nowrap;
      border: 1px solid var(--border-primary, #ddd);
      color: var(--text-secondary, #555); background: var(--bg-card, #fff);
    }
    .hrt-curve-controls button[aria-pressed="true"] {
      color: #e11d48; background: var(--bg-secondary, #fff1f2); border-color: #fb7185;
    }
    .hrt-curve-controls button:focus-visible { outline: 2px solid #f43f5e; outline-offset: 2px; }
    .hrt-curve-controls button:disabled { opacity: .5; cursor: not-allowed; }
    .hrt-curve-note { flex-basis: 100%; font-size: 11px; line-height: 1.5; color: var(--text-tertiary, #888); }
    .hrt-curve-note[hidden] { display: none !important; }
    @media (max-width: 640px), (pointer: coarse) {
      .hrt-curve-controls { order: 3; flex-basis: 100%; width: 100%; margin-left: 0; }
      .hrt-curve-controls button { min-height: 44px; padding: 10px 12px; font-size: 13px; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ───────────── React / Recharts 工具 ─────────────

  const FRAGMENT = Symbol.for('react.fragment');
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const nameOf = el => el.type?.displayName;
  const clone = (el, props) => ({ ...el, props: { ...el.props, ...props } });

  function fiberOf(el) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  }

  // 展开 children（数组、Fragment），只保留元素
  function flat(children, out = []) {
    if (Array.isArray(children)) children.forEach(c => flat(c, out));
    else if (children && typeof children === 'object' && children.props) {
      if (children.type === FRAGMENT) flat(children.props.children, out);
      else out.push(children);
    }
    return out;
  }

  // 按原结构替换元素；未改动的部分保持原引用，Recharts 靠引用匹配曲线
  function mapTree(children, fn) {
    if (Array.isArray(children)) {
      let changed = false;
      const next = children.map(c => {
        const r = mapTree(c, fn);
        if (r !== c) changed = true;
        return r;
      });
      return changed ? next : children;
    }
    if (!children || typeof children !== 'object' || !children.props) return children;
    if (children.type === FRAGMENT) {
      const inner = mapTree(children.props.children, fn);
      return inner === children.props.children ? children : clone(children, { children: inner });
    }
    return fn(children);
  }

  // ───────────── 曲线开关 ─────────────

  // CPA 开关要隐藏的系列；「只显示个体化」要隐藏的群体模型系列
  const CPA = new Set(['concCPA', 'concPersonalCPA', 'cpaCi95Low', 'cpaCi95Band']);
  const PRIOR = new Set(['concE2', 'concCPA', 'cpaCi95Low', 'cpaCi95Band']);
  // 识别用的全集：包含不隐藏的 CI 系列，避免沿 fiber 上溯时误认到别的组件
  const ALL = new Set([...CPA, ...PRIOR, 'concPersonal', 'ci95Low', 'ci95Band', 'ci68Low', 'ci68Band']);

  // 从 Recharts 组件的只读 props 识别系列，不改动网站数据
  function seriesKey(el) {
    for (let f = fiberOf(el), i = 0; f && i < 18; f = f.return, i++) {
      const key = f.memoizedProps?.dataKey;
      if (ALL.has(key)) return key;
    }
    return null;
  }

  // ───────────── 缩放 ─────────────

  const HOUR = 3600e3;
  const MIN_X = 2 * HOUR;      // 横轴最小视窗
  const MIN_Y = 0.02;          // 纵轴最多放大 50 倍
  const HOUR_STEPS = [1, 2, 6];
  const HOUR_GAP = 30;         // 小时刻度的最小间距（px）
  const PATCHED = Symbol.for('whatasiger.hrt.zoom');

  // 纵轴视窗：相对网站自动范围的比例，[0, 1] 即未缩放
  const yWin = { a: 0, b: 1 };
  const yZoomed = () => yWin.a > 0 || yWin.b < 1;

  let canvas;
  function textWidth(text) {
    canvas ??= document.createElement('canvas').getContext('2d') || false;
    if (!canvas) return text.length * 7;
    canvas.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    return canvas.measureText(text).width;
  }

  const isMainChart = children => flat(children).some(
    el => el.type === 'defs' && flat(el.props.children).some(g => g.props.id === 'colorConc')
  );

  // 横轴：放大到每 6 小时能留出间距后，在日期之间插入小时刻度
  function withHourTicks(el, props) {
    const [from, to] = el.props.domain || [];
    if (!isNum(from) || !isNum(to) || to <= from) return el;

    const m = props.margin || {};
    const axesWidth = flat(props.children)
      .filter(c => nameOf(c) === 'YAxis' && !c.props.hide)
      .reduce((sum, c) => sum + (c.props.width ?? 60), 0);
    const plotWidth = (props.width || 0) - (m.left || 0) - (m.right || 0) - axesWidth;
    const pxPerHour = plotWidth / ((to - from) / HOUR);
    const step = HOUR_STEPS.find(s => s * pxPerHour >= HOUR_GAP);
    if (!step) return el;

    const dateLabel = el.props.tickFormatter || (v => new Date(v).toLocaleDateString());
    const ticks = [];
    const day = new Date(from);
    day.setHours(0, 0, 0, 0);

    for (; day.getTime() <= to; day.setDate(day.getDate() + 1)) {
      // 小时标签与当天、次日的日期标签都留出间距
      const clearance = textWidth(String(dateLabel(day.getTime()))) / 2 + 12;
      for (let h = 0; h < 24; h += step) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
        if (t < from || t > to) continue;
        if (h && Math.min(h, 24 - h) * pxPerHour < clearance) continue;
        ticks.push(t);
      }
    }

    return clone(el, {
      ticks,
      interval: 0,
      minTickGap: 0,
      tickFormatter: (v, i) => {
        const d = new Date(v);
        return d.getHours() || d.getMinutes() ? String(d.getHours()) : dateLabel(v, i);
      }
    });
  }

  // 纵轴：在网站算出的范围内取一段
  function withYZoom(el) {
    const [lo, hi] = el.props.domain || [];
    if (el.props.hide || !yZoomed() || !isNum(lo) || !isNum(hi)) return el;
    const span = hi - lo;
    const from = lo + yWin.a * span, to = lo + yWin.b * span;
    return clone(el, {
      domain: [from, to],
      ticks: niceTicks(from, to),
      allowDataOverflow: true,
      allowDecimals: true
    });
  }

  // 视窗内取整齐的刻度（1、2、5 × 10ⁿ），约 4 格
  function niceTicks(from, to) {
    const raw = (to - from) / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].find(m => m * p >= raw) * p;
    const ticks = [];
    for (let t = Math.ceil(from / step) * step; t <= to + step * 1e-9; t += step) {
      ticks.push(Number(t.toFixed(10)));
    }
    return ticks;
  }

  // 结果按 children 缓存，悬停等重绘时引用不变，Recharts 不会重算
  const adjusted = new WeakMap();

  function adjustProps(props) {
    const children = props.children;
    if (!children || typeof children !== 'object' || !isMainChart(children)) return props;

    const key = `${yWin.a},${yWin.b},${props.width}`;
    const hit = adjusted.get(children);
    if (hit?.key === key) return hit.props;

    const next = {
      ...props,
      children: mapTree(children, el =>
        nameOf(el) === 'XAxis' ? withHourTicks(el, props)
          : nameOf(el) === 'YAxis' ? withYZoom(el)
            : el
      )
    };
    adjusted.set(children, { key, props: next });
    return next;
  }

  // Recharts 在 getDerivedStateFromProps 中读取坐标轴参数，
  // 在这一步传入改写后的副本；网站的 props 与数据本身不变
  function patch(Chart) {
    if (Chart[PATCHED] || typeof Chart.getDerivedStateFromProps !== 'function') return false;
    const original = Chart.getDerivedStateFromProps;
    Chart.getDerivedStateFromProps = (props, state) => original(adjustProps(props), state);
    Chart[PATCHED] = true;
    return true;
  }

  function chartFiber(wrapper) {
    let f = fiberOf(wrapper);
    for (let i = 0; f && i < 25; f = f.return, i++) {
      if (f.tag === 1 && f.stateNode?.state?.offset) return f;
    }
    return null;
  }

  // 找到图表实例，以及网站 xDomain 状态的 setter 和数据时间范围
  function chartContext(wrapper) {
    const chart = chartFiber(wrapper);
    if (!chart) return null;

    const inst = chart.stateNode;
    const xAxis = flat(inst.props.children).find(el => nameOf(el) === 'XAxis');
    const domain = xAxis?.props.domain;
    const ctx = { wrapper, inst, domain, setX: null, limits: null };
    if (!Array.isArray(domain)) return ctx;

    for (let f = chart.return, i = 0; f && i < 30 && !ctx.setX; f = f.return, i++) {
      for (const g of [f, f.alternate]) {
        if (g?.tag !== 0) continue;
        let setX = null, limits = null;
        for (let h = g.memoizedState; h; h = h.next) {
          if (h.queue?.dispatch && h.memoizedState === domain) setX = h.queue.dispatch;
          const v = Array.isArray(h.memoizedState) ? h.memoizedState[0] : null;
          if (v && isNum(v.minTime) && isNum(v.maxTime)) limits = v;
        }
        if (setX) {
          Object.assign(ctx, { setX, limits });
          break;
        }
      }
    }
    return ctx;
  }

  const mainWrappers = () =>
    [...document.querySelectorAll('linearGradient[id="colorConc"]')]
      .map(g => g.closest('.recharts-wrapper'))
      .filter(Boolean);

  // —— 横轴：驱动网站自己的 xDomain，数据窗口和纵轴自适应随之更新 ——

  let pendingX = null, sentX = null, xFrame = 0;

  // React 尚未重绘时，以上一次发出的值为准，连续滚动不丢步
  const currentX = ctx =>
    pendingX || (sentX && sentX.from === ctx.domain ? sentX.to : ctx.domain);

  function clampWidth(ctx, w) {
    const L = ctx.limits;
    const max = L ? Math.max(L.maxTime - L.minTime, MIN_X) : Infinity;
    return Math.min(Math.max(w, MIN_X), max);
  }

  function setX(ctx, from, width) {
    const L = ctx.limits;
    if (L) from = Math.max(Math.min(from, L.maxTime - width), Math.min(L.minTime, L.maxTime - width));
    pendingX = [from, from + width];
    if (xFrame) return;
    xFrame = requestAnimationFrame(() => {
      xFrame = 0;
      const next = pendingX;
      pendingX = null;
      const c = chartContext(ctx.wrapper);
      if (!next || !c?.setX) return;
      sentX = { from: c.domain, to: next };
      c.setX(next);
    });
  }

  function zoomX(ctx, fx, scale) {
    const d = currentX(ctx);
    if (!Array.isArray(d) || !ctx.setX) return;
    const w = d[1] - d[0];
    const nw = clampWidth(ctx, w * scale);
    setX(ctx, d[0] + fx * w - fx * nw, nw);
  }

  function panX(ctx, px, plotWidth) {
    const d = currentX(ctx);
    if (!Array.isArray(d) || !ctx.setX) return;
    const w = d[1] - d[0];
    setX(ctx, d[0] - px / plotWidth * w, w);
  }

  // —— 纵轴 ——

  let yFrame = 0;

  function setY(a, w) {
    w = Math.min(Math.max(w, MIN_Y), 1);
    a = Math.min(Math.max(a, 0), 1 - w);
    if (a === yWin.a && a + w === yWin.b) return;
    yWin.a = a;
    yWin.b = a + w;
    if (yFrame) return;
    yFrame = requestAnimationFrame(() => {
      yFrame = 0;
      for (const wrapper of mainWrappers()) chartFiber(wrapper)?.stateNode.forceUpdate();
      schedule();
    });
  }

  // fy：锚点在绘图区中的高度比例（0 为底部）
  function zoomY(fy, scale) {
    const w = yWin.b - yWin.a;
    const nw = Math.min(Math.max(w * scale, MIN_Y), 1);
    setY(yWin.a + fy * w - fy * nw, nw);
  }

  // —— 手势 ——

  function hit(e) {
    const wrapper = e.target instanceof Element && e.target.closest('.recharts-wrapper');
    if (!wrapper?.querySelector('linearGradient[id="colorConc"]')) return null;
    const ctx = chartContext(wrapper);
    if (ctx && patch(ctx.inst.constructor)) ctx.inst.forceUpdate();
    return ctx;
  }

  function plotPoint(ctx, x, y) {
    const r = ctx.wrapper.getBoundingClientRect();
    const o = ctx.inst.state.offset;
    return { x: x - r.left - o.left, y: y - r.top - o.top, w: o.width, h: o.height };
  }

  // 滚轮：绘图区内缩放横轴；Shift 或在纵轴上滚动则缩放纵轴；横向滚动平移
  window.addEventListener('wheel', e => {
    const ctx = hit(e);
    if (!ctx) return;
    const p = plotPoint(ctx, e.clientX, e.clientY);
    if (p.y < 0 || p.y > p.h) return;

    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? p.h : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const inPlot = p.x >= 0 && p.x <= p.w;

    if (inPlot && !e.shiftKey && Math.abs(dx) > Math.abs(dy)) return panX(ctx, -dx, p.w);

    // 触控板双指捏合会带 ctrlKey，增量较小
    const delta = e.shiftKey ? (dy || dx) : dy;
    const scale = Math.exp(delta * (e.ctrlKey ? 0.01 : 0.0015));
    if (inPlot && !e.shiftKey) zoomX(ctx, p.x / p.w, scale);
    else zoomY(1 - p.y / p.h, scale);
  }, { capture: true, passive: false });

  const touches = new Map();
  let gesture = null;
  let suppressClickUntil = 0;

  const spread = (p1, p2) => ({
    dx: Math.abs(p1.x - p2.x),
    dy: Math.abs(p1.y - p2.y),
    cx: (p1.x + p2.x) / 2,
    cy: (p1.y + p2.y) / 2
  });

  window.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const ctx = hit(e);
    if (!ctx) return;

    if (e.pointerType === 'mouse') {
      const p = plotPoint(ctx, e.clientX, e.clientY);
      if (p.x < 0 || p.x > p.w || p.y < 0 || p.y > p.h) return;
      gesture = {
        type: 'drag', ctx, x: e.clientX, y: e.clientY, moved: false,
        d: currentX(ctx), a: yWin.a, w: yWin.b - yWin.a, pw: p.w, ph: p.h
      };
      return;
    }

    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      gesture = {
        type: 'pinch', ctx,
        s: spread(...touches.values()),
        r: ctx.wrapper.getBoundingClientRect(),
        o: { ...ctx.inst.state.offset },
        d: currentX(ctx), a: yWin.a, w: yWin.b - yWin.a
      };
    }
  }, true);

  window.addEventListener('pointermove', e => {
    const g = gesture;
    if (!g) return;

    // 鼠标拖动平移：横轴始终可拖，纵轴放大后可拖
    if (g.type === 'drag') {
      if (e.pointerType !== 'mouse') return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      if (Array.isArray(g.d)) {
        const w = g.d[1] - g.d[0];
        setX(g.ctx, g.d[0] - dx / g.pw * w, w);
      }
      setY(g.a + dy / g.ph * g.w, g.w);
      return;
    }

    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2) return;

    // 双指：横向张合缩放横轴，纵向张合缩放纵轴，移动则平移；
    // 起始方向偏向某一轴时，另一轴不缩放
    const now = spread(...touches.values());
    const { s, r, o } = g;
    const useX = s.dx >= 40 && s.dx >= s.dy * 0.5;
    const useY = s.dy >= 40 && s.dy >= s.dx * 0.5;

    if (Array.isArray(g.d)) {
      const fx0 = (s.cx - r.left - o.left) / o.width;
      const fx1 = (now.cx - r.left - o.left) / o.width;
      const w = g.d[1] - g.d[0];
      const nw = clampWidth(g.ctx, useX ? w * s.dx / Math.max(now.dx, 1) : w);
      setX(g.ctx, g.d[0] + fx0 * w - fx1 * nw, nw);
    }

    const fy0 = 1 - (s.cy - r.top - o.top) / o.height;
    const fy1 = 1 - (now.cy - r.top - o.top) / o.height;
    const nw = Math.min(Math.max(useY ? g.w * s.dy / Math.max(now.dy, 1) : g.w, MIN_Y), 1);
    setY(g.a + fy0 * g.w - fy1 * nw, nw);
  }, true);

  function endPointer(e) {
    if (e.pointerType === 'mouse') {
      if (gesture?.type === 'drag') {
        if (gesture.moved) suppressClickUntil = performance.now() + 300;
        gesture = null;
      }
      return;
    }
    if (touches.delete(e.pointerId) && gesture?.type === 'pinch') gesture = null;
  }
  window.addEventListener('pointerup', endPointer, true);
  window.addEventListener('pointercancel', endPointer, true);

  // 拖动结束时不触发网站的点击（如打开用药记录）
  window.addEventListener('click', e => {
    if (performance.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
      suppressClickUntil = 0;
    }
  }, true);

  // ───────────── 控件 ─────────────

  // 值相同则不写，避免触发 MutationObserver 循环；value 为 null 表示移除
  function attr(el, name, value) {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function text(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  function toggle(name) {
    prefs[name] = !prefs[name];
    try { localStorage.setItem(STORAGE, JSON.stringify(prefs)); } catch {}
    refresh();
  }

  const toolbars = new WeakMap();

  function controlsFor(card) {
    const cached = toolbars.get(card);
    if (cached?.root.isConnected) return cached;

    const heading = card.querySelector('h2');
    if (!heading?.parentElement) return null;

    const root = document.createElement('div');
    root.className = 'hrt-curve-controls';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '曲线显示控制');

    const button = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };

    const cpa = button('', () => toggle('hideCPA'));
    const personal = button('只显示个体化模型', () => toggle('personalOnly'));
    const resetY = button('重置纵轴', () => setY(0, 1));
    resetY.title = '滚轮缩放横轴，Shift + 滚轮或在纵轴上滚动缩放纵轴，拖动平移；触屏双指缩放。横轴可用网站自带的重置按钮还原。';

    const note = document.createElement('span');
    note.className = 'hrt-curve-note';
    note.setAttribute('role', 'status');

    root.append(cpa, personal, resetY, note);
    heading.after(root); // 桌面端位于工具图标旁，移动端自动换行

    const controls = { root, cpa, personal, resetY, note };
    toolbars.set(card, controls);
    return controls;
  }

  function refresh() {
    // colorConc 渐变只存在于主图，借此排除缩略图与分享导出图
    for (const chart of mainWrappers()) {
      const card = chart.closest('.glass-card');
      const c = card && controlsFor(card);
      if (!c) continue;

      const cf = chartFiber(chart);
      if (cf && patch(cf.type)) cf.stateNode.forceUpdate();

      const groups = [...chart.querySelectorAll('.recharts-area, .recharts-line, .recharts-scatter')]
        .map(el => [el, seriesKey(el)]);
      const keys = new Set(groups.map(([, k]) => k));
      const identified = keys.has('concE2');
      const hasPersonal = keys.has('concPersonal');

      // 网站也用 concCPA 存放 BICA，按右侧坐标轴标题区分
      const axes = chart.querySelectorAll('.recharts-yAxis');
      const rightAxis = [...axes].find(a => /CPA\s*\(/i.test(a.textContent || ''));
      const hasCPA = Boolean(rightAxis);
      const hideCPA = prefs.hideCPA && hasCPA;
      const only = prefs.personalOnly && hasPersonal && identified;

      c.cpa.disabled = !identified || !hasCPA;
      c.personal.disabled = !identified || !hasPersonal;
      c.resetY.disabled = !yZoomed();
      text(c.cpa, prefs.hideCPA ? '显示 CPA 曲线' : '隐藏 CPA 曲线');
      attr(c.cpa, 'aria-pressed', String(prefs.hideCPA));
      attr(c.personal, 'aria-pressed', String(only));
      c.cpa.title = hasCPA
        ? '切换 CPA 曲线、区间及右侧坐标轴的显示'
        : '当前图表没有 CPA 系列';
      c.personal.title = hasPersonal
        ? '隐藏群体模型，保留个体化曲线及 E2 置信区间；再次点击恢复'
        : '当前尚无个体化模型，请先启用校准并录入检测结果';
      text(c.note, !identified ? '未能识别曲线，可能需要更新脚本。'
        : !hasPersonal ? '当前尚无个体化曲线。' : '');
      c.note.hidden = !c.note.textContent;

      for (const [el, key] of groups) {
        const hide = (hideCPA && CPA.has(key)) || (only && PRIOR.has(key));
        attr(el, 'data-hrt-curve-hidden', hide ? '1' : null);
      }
      for (const axis of axes) {
        attr(axis, 'data-hrt-curve-hidden', hideCPA && axis === rightAxis ? '1' : null);
      }
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refresh(); });
  }

  // SPA 切页、缩放、重绘后自动重新应用
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'd']
  });

  // 多标签页同步开关状态（只开一个标签页的话可删）
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE) return;
    prefs = parse(e.newValue);
    schedule();
  });

  refresh();
})();
