// ==UserScript==
// @name         HRT Tracker · 曲线显示开关
// @namespace    whatasiger.hrt.curves
// @version      1.1.0
// @description  添加 CPA 曲线开关和只显示个体化模型开关，支持移动端。
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

  // CPA 开关要隐藏的系列；「只显示个体化」要隐藏的群体模型系列
  const CPA = new Set(['concCPA', 'concPersonalCPA', 'cpaCi95Low', 'cpaCi95Band']);
  const PRIOR = new Set(['concE2', 'concCPA', 'cpaCi95Low', 'cpaCi95Band']);
  // 识别用的全集：包含不隐藏的 CI 系列，避免沿 fiber 上溯时误认到别的组件
  const ALL = new Set([...CPA, ...PRIOR, 'concPersonal', 'ci95Low', 'ci95Band', 'ci68Low', 'ci68Band']);

  // 从 Recharts 组件的只读 props 识别系列，不改动网站数据
  function seriesKey(el) {
    const prop = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let f = prop && el[prop], i = 0; f && i < 18; f = f.return, i++) {
      const key = f.memoizedProps?.dataKey;
      if (ALL.has(key)) return key;
    }
    return null;
  }

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

    const button = (label, pref) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => toggle(pref));
      return b;
    };

    const cpa = button('', 'hideCPA');
    const personal = button('只显示个体化模型', 'personalOnly');
    const note = document.createElement('span');
    note.className = 'hrt-curve-note';
    note.setAttribute('role', 'status');

    root.append(cpa, personal, note);
    heading.after(root); // 桌面端位于工具图标旁，移动端自动换行

    const controls = { root, cpa, personal, note };
    toolbars.set(card, controls);
    return controls;
  }

  function refresh() {
    // colorConc 渐变只存在于主图，借此排除缩略图与分享导出图
    for (const gradient of document.querySelectorAll('linearGradient[id="colorConc"]')) {
      const chart = gradient.closest('.recharts-wrapper');
      const card = chart?.closest('.glass-card');
      const c = card && controlsFor(card);
      if (!c) continue;

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
  addEventListener('storage', e => {
    if (e.key !== STORAGE) return;
    prefs = parse(e.newValue);
    schedule();
  });

  refresh();
})();
