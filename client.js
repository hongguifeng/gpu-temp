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
    /** Route that applies a fan curve on the Host half. */
    const FAN_URL = '/gpu-temp/fan';
    /** Preset curves offered next to the editor. */
    const PRESETS = [
      ['quiet', '40:20,50:25,60:35,70:50,80:70,85:100'],
      ['balance', '40:20,50:30,60:45,70:75,80:100'],
      ['max', '30:100,40:100'],
    ];
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
      fan: 'Fan',
      auto: 'auto',
      manual: 'manual',
      apply: 'Apply',
      applying: 'Applying…',
      quiet: 'Quiet',
      balance: 'Balanced',
      max: 'Full',
      curvePlaceholder: '40:20,50:30,60:45,70:75,80:100',
      curveBad: 'Bad curve',
      curveOk: 'Curve applied',
      noFan: 'No fan channel',
      autoMode: 'Default',
      autoOk: 'BIOS control restored',
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
      fan: '风扇',
      auto: '自动',
      manual: '手动',
      apply: '应用',
      applying: '应用中…',
      quiet: '静音',
      balance: '均衡',
      max: '全速',
      curvePlaceholder: '40:20,50:30,60:45,70:75,80:100',
      curveBad: '曲线格式不对',
      curveOk: '曲线已应用',
      noFan: '未检测到风扇通道',
      autoMode: '默认',
      autoOk: '已恢复 BIOS 控制',
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
.gt-fan{display:flex;flex-direction:column;gap:6px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:9px}
.gt-fan-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.gt-fan-title{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.gt-fan-state{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.gt-fan-edit{display:flex;gap:6px}
.gt-input{flex:1;min-width:0;height:24px;padding:0 7px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums}
.gt-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.gt-btn{appearance:none;border:0;height:24px;padding:0 9px;border-radius:6px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px}
.gt-btn:hover{color:var(--dsw-alias-label-primary)}
.gt-btn:disabled{opacity:.55;cursor:default}
.gt-btn.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.gt-btn.is-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.gt-presets{display:flex;gap:6px}
.gt-msg{font-size:11px}
.gt-msg.is-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-warn-primary))}
.gt-msg.is-err{color:var(--dsw-alias-state-error-primary)}
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
      const [fanDraft, setFanDraft] = React.useState('');
      const [fanBusy, setFanBusy] = React.useState(false);
      const [fanMsg, setFanMsg] = React.useState(null);
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

      // Seed the curve editor from the Host snapshot when the panel opens.
      React.useEffect(() => {
        if (!open) return;
        const curve = view.data?.fan?.curve;
        if (typeof curve === 'string' && curve !== '') setFanDraft(curve);
      }, [open]);

      const applyCurve = React.useCallback(
        async (value) => {
          const curve = String(value ?? fanDraft).trim();
          setFanBusy(true);
          setFanMsg(null);
          try {
            const response = await fetch(`${FAN_URL}?curve=${encodeURIComponent(curve)}&mode=manual`, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            const reply = await response.json();
            if (reply.ok === true) {
              setFanDraft(curve);
              setFanMsg({ ok: true, text: translate('curveOk') });
              void load(false);
            } else {
              setFanMsg({ ok: false, text: String(reply.error ?? translate('curveBad')) });
            }
          } catch (error) {
            setFanMsg({ ok: false, text: error instanceof Error ? error.message : String(error) });
          } finally {
            setFanBusy(false);
          }
        },
        [fanDraft, load, translate],
      );

      const setAuto = React.useCallback(async () => {
        setFanBusy(true);
        setFanMsg(null);
        try {
          const response = await fetch(`${FAN_URL}?mode=auto`, { cache: 'no-store', headers: { accept: 'application/json' } });
          const reply = await response.json();
          if (reply.ok === true) {
            setFanMsg({ ok: true, text: translate('autoOk') });
            void load(false);
          } else {
            setFanMsg({ ok: false, text: String(reply.error ?? translate('curveBad')) });
          }
        } catch (error) {
          setFanMsg({ ok: false, text: error instanceof Error ? error.message : String(error) });
        } finally {
          setFanBusy(false);
        }
      }, [load, translate]);

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

      const fan = data?.fan ?? null;
      const fanSection = h(
        'div',
        { className: 'gt-fan' },
        h(
          'div',
          { className: 'gt-fan-head' },
          h('span', { className: 'gt-fan-title' }, translate('fan')),
          h(
            'span',
            { className: 'gt-fan-state' },
            fan === null
              ? translate('noFan')
              : `${fan.rpm ?? '?'} RPM · ${fan.duty}% · ${fan.mode === 'auto' || !fan.manual ? translate('auto') : translate('manual')}`,
          ),
        ),
        fan === null
          ? null
          : h(
              'div',
              { className: 'gt-fan-edit' },
              h('input', {
                className: 'gt-input',
                value: fanDraft,
                placeholder: translate('curvePlaceholder'),
                spellCheck: false,
                onChange: (event) => setFanDraft(event.target.value),
              }),
              h(
                'button',
                { type: 'button', className: 'gt-btn is-primary', disabled: fanBusy, onClick: () => void applyCurve() },
                translate(fanBusy ? 'applying' : 'apply'),
              ),
            ),
        fan === null
          ? null
          : h(
              'div',
              { className: 'gt-presets' },
              h(
                'button',
                { type: 'button', className: 'gt-btn', disabled: fanBusy, onClick: () => void setAuto() },
                translate('autoMode'),
              ),
              PRESETS.map(([key, curve]) =>
                h(
                  'button',
                  { key, type: 'button', className: 'gt-btn', disabled: fanBusy, onClick: () => void applyCurve(curve) },
                  translate(key),
                ),
              ),
            ),
        fanMsg === null
          ? null
          : h('span', { className: `gt-msg ${fanMsg.ok ? 'is-ok' : 'is-err'}` }, fanMsg.text),
      );

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
              fanSection,
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
