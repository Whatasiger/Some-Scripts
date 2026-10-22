HRT Tracker 曲线显示开关
// ==UserScript==
// @name         HRT Tracker · 曲线显示开关
// @namespace    whatasiger.hrt.curves
// @version      1.0.1
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

  let prefs = {
    hideCPA: false,
    personalOnly: false
  };

  try {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE) || '{}'
    );
    prefs.hideCPA = saved.hideCPA === true;
    prefs.personalOnly = saved.personalOnly === true;
  } catch (_) {}

  const style = document.createElement('style');
  style.id = ID + '-style';
  style.textContent = `
    [data-hrt-curve-hidden="1"] {
      display: none !important;
    }

    .hrt-curve-controls {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: auto;
      max-width: 100%;
      box-sizing: border-box;
    }

    .hrt-curve-controls button {
      appearance: none;
      -webkit-appearance: none;
      cursor: pointer;
      touch-action: manipulation;
      font: inherit;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 600;
      padding: 7px 10px;
      border-radius: 9px;
      border: 1px solid var(--border-primary, #ddd);
      color: var(--text-secondary, #555);
      background: var(--bg-card, #fff);
      white-space: nowrap;
      box-sizing: border-box;
    }

    .hrt-curve-controls button[aria-pressed="true"] {
      color: #e11d48;
      background: var(--bg-secondary, #fff1f2);
      border-color: #fb7185;
    }

    .hrt-curve-controls button:focus-visible {
      outline: 2px solid #f43f5e;
      outline-offset: 2px;
    }

    .hrt-curve-controls button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    .hrt-curve-note {
      flex-basis: 100%;
      font-size: 11px;
      line-height: 1.5;
      color: var(--text-tertiary, #888);
    }

    .hrt-curve-note[hidden] {
      display: none !important;
    }

    @media (max-width: 640px), (pointer: coarse) {
      .hrt-curve-controls {
        order: 3;
        flex-basis: 100%;
        width: 100%;
        margin-left: 0;
      }

      .hrt-curve-controls button {
        min-height: 44px;
        padding: 10px 12px;
        font-size: 13px;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const cpaKeys = new Set([
    'concCPA',
    'concPersonalCPA',
    'cpaCi95Low',
    'cpaCi95Band'
  ]);

  const priorKeys = new Set([
    'concE2',
    'concCPA',
    'cpaCi95Low',
    'cpaCi95Band'
  ]);

  const seriesKeys = new Set([
    ...cpaKeys,
    ...priorKeys,
    'concPersonal',
    'concPersonalCPA',
    'ci95Low',
    'ci95Band',
    'ci68Low',
    'ci68Band'
  ]);

  // 从 Recharts 对应组件的只读 props 中识别系列。
  // 不修改用药记录、校准参数或网站的计算结果。
  function seriesKey(element) {
    const own = Object.keys(element).find(
      key => key.startsWith('__reactFiber$')
    );

    let fiber = own ? element[own] : null;

    for (
      let depth = 0;
      fiber && depth < 18;
      depth++, fiber = fiber.return
    ) {
      const props = fiber.memoizedProps;

      if (props && seriesKeys.has(props.dataKey)) {
        return props.dataKey;
      }
    }

    return null;
  }

  function setHidden(element, hidden) {
    if (hidden) {
      if (element.getAttribute('data-hrt-curve-hidden') !== '1') {
        element.setAttribute('data-hrt-curve-hidden', '1');
      }
    } else if (element.hasAttribute('data-hrt-curve-hidden')) {
      element.removeAttribute('data-hrt-curve-hidden');
    }
  }

  function setText(element, value) {
    if (element.textContent !== value) {
      element.textContent = value;
    }
  }

  function setPressed(element, value) {
    const next = String(value);
    if (element.getAttribute('aria-pressed') !== next) {
      element.setAttribute('aria-pressed', next);
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(prefs));
    } catch (_) {}

    refresh();
  }

  const toolbars = new WeakMap();

  function controlsFor(card) {
    const cached = toolbars.get(card);

    if (cached && cached.root.isConnected) {
      return cached;
    }

    const heading = card.querySelector('h2');
    const header = heading?.parentElement;

    if (!header) return null;

    const root = document.createElement('div');
    root.className = 'hrt-curve-controls';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '曲线显示控制');

    const cpa = document.createElement('button');
    cpa.type = 'button';
    cpa.addEventListener('click', () => {
      prefs.hideCPA = !prefs.hideCPA;
      persist();
    });

    const personal = document.createElement('button');
    personal.type = 'button';
    personal.textContent = '只显示个体化模型';
    personal.addEventListener('click', () => {
      prefs.personalOnly = !prefs.personalOnly;
      persist();
    });

    const note = document.createElement('span');
    note.className = 'hrt-curve-note';
    note.setAttribute('role', 'status');

    root.append(cpa, personal, note);

    // 桌面端位于原有工具图标旁，移动端自动换行。
    header.insertBefore(root, heading.nextSibling);

    const controls = { root, cpa, personal, note };
    toolbars.set(card, controls);

    return controls;
  }

  function refresh() {
    // 只操作主图，排除缩略图与分享导出图。
    const gradients = document.querySelectorAll(
      'linearGradient[id="colorConc"]'
    );

    for (const gradient of gradients) {
      const chart = gradient.closest('.recharts-wrapper');
      const card = chart?.closest('.glass-card');

      if (!chart || !card) continue;

      const controls = controlsFor(card);
      if (!controls) continue;

      const groups = [
        ...chart.querySelectorAll(
          '.recharts-area, .recharts-line, .recharts-scatter'
        )
      ].map(element => ({
        element,
        key: seriesKey(element)
      }));

      const identified = groups.some(
        group => group.key === 'concE2'
      );

      const hasPersonal = groups.some(
        group => group.key === 'concPersonal'
      );

      const axes = [
        ...chart.querySelectorAll('.recharts-yAxis')
      ];

      const rightAxis = axes.find(
        axis => /CPA\s*\(/i.test(axis.textContent || '')
      );

      // 网站也用 concCPA 存放 BICA，按坐标轴区分。
      const hasCPA = Boolean(rightAxis);
      const only = prefs.personalOnly && hasPersonal && identified;

      controls.cpa.disabled = !identified || !hasCPA;
      controls.personal.disabled = !identified || !hasPersonal;

      setText(
        controls.cpa,
        prefs.hideCPA ? '显示 CPA 曲线' : '隐藏 CPA 曲线'
      );

      setPressed(controls.cpa, prefs.hideCPA);
      setPressed(controls.personal, only);

      controls.cpa.title = hasCPA
        ? '切换 CPA 曲线、区间及右侧坐标轴的显示'
        : '当前图表没有 CPA 系列';

      controls.personal.title = hasPersonal
        ? '隐藏群体模型，保留个体化曲线及 E2 置信区间；再次点击恢复'
        : '当前尚无个体化模型，请先启用校准并录入检测结果';

      setText(
        controls.note,
        !identified
          ? '未能识别曲线，可能需要更新脚本。'
          : !hasPersonal
            ? '当前尚无个体化曲线。'
            : ''
      );

      controls.note.hidden = !controls.note.textContent;

      for (const { element, key } of groups) {
        const hidden = Boolean(key) && (
          (
            prefs.hideCPA &&
            hasCPA &&
            cpaKeys.has(key)
          ) ||
          (
            only &&
            priorKeys.has(key)
          )
        );

        setHidden(element, hidden);
      }

      for (const axis of axes) {
        setHidden(
          axis,
          prefs.hideCPA && axis === rightAxis
        );
      }
    }
  }

  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }

  // SPA 页面切换、缩放和重新绘图后自动重新应用。
  const observer = new MutationObserver(schedule);

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'd']
  });

  window.addEventListener('storage', event => {
    if (event.key !== STORAGE) return;

    try {
      const saved = JSON.parse(event.newValue || '{}');

      prefs = {
        hideCPA: saved.hideCPA === true,
        personalOnly: saved.personalOnly === true
      };

      schedule();
    } catch (_) {}
  });

  refresh();
})();
