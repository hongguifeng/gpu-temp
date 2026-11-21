/**
 * Client half of the GPU temperature bundle.
 *
 * Shows the hottest card's temperature as a bare number in the composer dock.
 * Clicking opens a portal panel (rendered into document.body, anchored above
 * the pill) that lists every card; being a portal it is never clipped or
 * squeezed by the dock. Polls the Host half's read-only snapshot route.
 */

window.__ModuleLoader__.load({
  id: '@local/gpu-temp',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** Locale namespace owning this bundle's copy. */
    const NS = 'gpu-temp';
    /** Host half's snapshot route. */
    const STATE_URL = '/gpu-temp/state';
    /** How often the browser re-reads the Host snapshot while visible. */
    const POLL_MS = 5_000;
    /** Opened panel width, capped to the viewport at render time. */
    const PANEL_WIDTH = 300;

    const en = {
      name: 'GPU temperature',
      temp: 'temp',
      mem: 'mem',
      clock: 'SM',
      power: 'power',
      link: 'link',
      none: 'No GPU',
      error: 'nvidia-smi failed',
      cards: '{n} GPU',
      cards_plural: '{n} GPUs',
      updated: 'Updated',
      refresh: 'Refresh',
      busy: 'Refreshing…',
      aria: 'GPU temperature',
      open: 'Show all GPUs',
      close: 'Close GPU list',
    };

    const zh = {
      name: 'GPU 温度',
      temp: '温度',
      mem: '显存',
      clock: 'SM',
      power: '功耗',
      link: '链路',
      none: '无 GPU',
      error: 'nvidia-smi 失败',
      cards: '{n} 张卡',
      cards_plural: '{n} 张卡',
      updated: '更新于',
      refresh: '刷新',
      busy: '刷新中…',
      aria: 'GPU 温度',
      open: '查看全部显卡',
      close: '关闭显卡列表',
    };

    const CSS = `
.gt-anchor{display:inline-flex;flex:none}
.gt-pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:1px 6px;border:0;
  background:0 0;border-radius:6px;color:var(--dsw-alias-label-tertiary);font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;flex:none}
.gt-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.gt-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.gt-pill[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.gt-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.gt-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.gt-dot.is-danger{background:var(--dsw-alias-state-error-primary)}
.gt-v{color:var(--dsw-alias-label-secondary)}
.gt-v.is-warn{color:var(--dsw-alias-state-warn-primary)}
.gt-v.is-danger{color:var(--dsw-alias-state-error-primary)}
.gt-count{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:1px}
.gt-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:12px;border-radius:12px;
  background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.18));
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;
  display:flex;flex-direction:column;gap:11px;overflow:auto}
.gt-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.gt-panel-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.gt-panel-sub{color:var(--dsw-alias-label-secondary);font-size:11px}
.gt-row{display:flex;flex-direction:column;gap:4px}
.gt-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.gt-row-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-row-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:500;flex:none}
.gt-row-value.is-warn{color:var(--dsw-alias-state-warn-primary)}
.gt-row-value.is-danger{color:var(--dsw-alias-state-error-primary)}
.gt-row-foot{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.gt-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  border-top:.5px solid var(--dsw-alias-border-l1);padding-top:8px}
.gt-foot-note{color:var(--dsw-alias-label-secondary);font-size:11px}
.gt-link{appearance:none;border:0;background:0 0;color:var(--dsw-alias-brand-primary);cursor:pointer;
  font:inherit;font-size:11px;padding:2px 5px;border-radius:4px}
.gt-link:hover{background:var(--dsw-alias-bg-layer-2)}
.gt-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.gt-error{color:var(--dsw-alias-state-error-primary)}
`;

    /**
     * Warning level of a temperature.
     * @param temp - Die temperature in °C.
     */
    function levelOf(temp) {
      if (temp >= 90) return 'danger';
      if (temp >= 80) return 'warn';
      return 'ok';
    }

    /**
     * The dock-row pill and its opened portal panel.
     * @param props - slot props; `t` is bound to this bundle's namespace.
     */
    function GpuPill({ t }) {
      const translate = React.useCallback((key) => (typeof t === 'function' ? t(key) : key), [t]);
      const format = React.useCallback(
        (key, values) =>
          Object.entries(values).reduce(
            (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
            translate(key),
          ),
        [translate],
      );
      const [view, setView] = React.useState({ status: 'loading', data: null });
      const [busy, setBusy] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [position, setPosition] = React.useState(undefined);
      const anchorRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async (force) => {
        if (force) setBusy(true);
        try {
          const response = await fetch(`${STATE_URL}${force ? '?force=1' : ''}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (alive.current) setView({ status: 'ready', data });
        } catch (error) {
          if (alive.current) setView({ status: 'unreachable', message: error instanceof Error ? error.message : String(error) });
        } finally {
          if (force && alive.current) setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        void load(false);
        const timer = setInterval(() => {
          if (!document.hidden) void load(false);
        }, POLL_MS);
        const onVisible = () => {
          if (!document.hidden) void load(false);
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [load]);

      // Place the panel above the pill, clamped to the viewport, and keep it
      // there while the window resizes or the page scrolls.
      React.useLayoutEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const width = Math.min(PANEL_WIDTH, window.innerWidth - 24);
          const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
          setPosition({
            left,
            width,
            bottom: Math.max(12, window.innerHeight - rect.top + 8),
            maxHeight: Math.max(140, rect.top - 20),
          });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) {
          setPosition(undefined);
          return undefined;
        }
        const onPointerDown = (event) => {
          const target = event.target;
          if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const data = view.status === 'ready' ? view.data : undefined;
      const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
      const hottest = gpus.reduce(
        (best, item) => ((item.temp ?? -1) > (best?.temp ?? -1) ? item : best),
        null,
      );
      const temp = hottest?.temp ?? null;
      const level = temp === null ? 'ok' : levelOf(temp);

      const label = temp === null
        ? h('span', { className: 'gt-error' }, translate(view.status === 'unreachable' ? 'error' : 'none'))
        : h('span', { className: `gt-v${level === 'ok' ? '' : ` is-${level}`}` }, `${Math.round(temp)}°C`);

      const panel = open
        ? ReactDOM.createPortal(
            h(
              'div',
              {
                ref: panelRef,
                className: 'gt-panel',
                role: 'dialog',
                'aria-label': translate('aria'),
                style: position === undefined
                  ? { visibility: 'hidden', left: 0, bottom: 0, width: PANEL_WIDTH }
                  : position,
              },
              h(
                'div',
                { className: 'gt-panel-head' },
                h('span', { className: 'gt-panel-title' }, translate('aria')),
                h('span', { className: 'gt-panel-sub' }, format(gpus.length === 1 ? 'cards' : 'cards_plural', { n: gpus.length })),
              ),
              gpus.length === 0
                ? h('div', { className: 'gt-row-foot' }, h('span', { className: 'gt-error' }, translate('none')))
                : gpus.map((gpu) => {
                    const gpuLevel = gpu.temp === null || gpu.temp === undefined ? 'ok' : levelOf(gpu.temp);
                    const meta = [];
                    if (gpu.memTemp !== null && gpu.memTemp !== undefined) meta.push(`${translate('mem')} ${Math.round(gpu.memTemp)}°C`);
                    meta.push(`${gpu.clock ?? '?'} MHz`);
                    meta.push(`${gpu.power ?? '?'} W`);
                    meta.push(`Gen${gpu.gen ?? '?'} x${gpu.width ?? '?'}`);
                    return h(
                      'div',
                      { className: 'gt-row', key: gpu.index },
                      h(
                        'div',
                        { className: 'gt-row-head' },
                        h('span', { className: 'gt-row-label' }, `GPU${gpu.index} · ${gpu.name}`),
                        h(
                          'span',
                          { className: `gt-row-value${gpuLevel === 'ok' ? '' : ` is-${gpuLevel}`}` },
                          gpu.temp === null || gpu.temp === undefined ? '—' : `${Math.round(gpu.temp)}°C`,
                        ),
                      ),
                      h('div', { className: 'gt-row-foot' }, h('span', null, meta.join(' · '))),
                    );
                  }),
              h(
                'div',
                { className: 'gt-panel-foot' },
                h('span', { className: 'gt-foot-note' }, `${translate('updated')} ${data?.ts ? new Date(data.ts).toLocaleTimeString() : '—'}`),
                h(
                  'button',
                  { type: 'button', className: 'gt-link', onClick: () => void load(true), disabled: busy },
                  translate(busy ? 'busy' : 'refresh'),
                ),
              ),
            ),
            document.body,
          )
        : null;

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
        'span',
        { className: 'gt-anchor', ref: anchorRef },
        h(
          'button',
          {
            type: 'button',
            className: 'gt-pill',
            title: hottest
              ? `GPU ${hottest.index} · ${hottest.name} · ${Math.round(temp)}°C`
              : translate(view.status === 'unreachable' ? 'error' : 'none'),
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            'aria-label': `${translate('aria')}. ${translate(open ? 'close' : 'open')}`,
          },
          h('span', { className: `gt-dot${level === 'ok' ? '' : ` is-${level}`}` }),
          label,
          gpus.length > 1 ? h('span', { className: 'gt-count' }, `+${gpus.length - 1}`) : null,
        ),
        panel,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the composer-dock occupant.
       * @param ctx - Client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'gpu-temp: dictionaries');
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'gpu-temp', order: 1, locale: NS },
            GpuPill,
          ),
        );
      },
    };
  },
});
