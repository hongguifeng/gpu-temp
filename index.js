/**
 * Host half of the GPU temperature bundle.
 *
 * Polls `nvidia-smi` for die temperature plus clocks/power/link, caches the
 * last snapshot, and serves it to the Web page from one read-only route.
 * Nothing is written anywhere; the route only reads.
 */
import { execFile } from 'node:child_process';

/** Read-only snapshot route consumed by the Client half. */
const ROUTE_PATH = '/gpu-temp/state';

/** Fields asked from nvidia-smi, in display order. */
const QUERY_FIELDS = [
  'index',
  'name',
  'temperature.gpu',
  'clocks.sm',
  'power.draw',
  'pcie.link.gen.current',
  'pcie.link.width.current',
];

/** Required service: the HTTP carrier that serves the snapshot route. */
export const inject = ['webServer'];

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? { error: error.message || String(error) } : { stdout: String(stdout) });
    });
  });
}

function num(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` lines. */
function parseQuery(stdout) {
  const gpus = [];
  for (const line of stdout.split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < QUERY_FIELDS.length) continue;
    const index = num(cells[0]);
    if (index === null) continue;
    gpus.push({
      index,
      name: cells[1],
      temp: num(cells[2]),
      clock: num(cells[3]),
      power: num(cells[4]),
      gen: num(cells[5]),
      width: num(cells[6]),
      memTemp: null,
    });
  }
  return gpus;
}

/** Pull `Memory Current Temp` out of `nvidia-smi -q -d TEMPERATURE`. */
function parseMemoryTemp(stdout, gpus) {
  const matches = [...stdout.matchAll(/Memory Current Temp\s*:\s*(\d+)\s*C/g)];
  matches.forEach((match, i) => {
    if (gpus[i]) gpus[i].memTemp = num(match[1]);
  });
}

/**
 * Activate the poller and the snapshot route.
 * @param ctx - Host plugin context.
 * @param config - Resolved row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const pollIntervalMs = clampNumber(config.pollIntervalMs, 5_000, 1_000, 60_000);
  const timeoutMs = clampNumber(config.timeoutMs, 4_000, 1_000, 30_000);

  let snapshot = Object.freeze({ ok: false, ts: null, gpus: [], error: { code: 'pending' } });
  let inFlight = null;
  let lastAttempt = 0;

  async function poll() {
    const query = await run(
      'nvidia-smi',
      [`--query-gpu=${QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      timeoutMs,
    );
    if (query.error !== undefined) {
      return { ok: false, ts: new Date().toISOString(), gpus: [], error: { code: 'exec', message: query.error } };
    }
    const gpus = parseQuery(query.stdout);
    if (gpus.length === 0) {
      return { ok: false, ts: new Date().toISOString(), gpus: [], error: { code: 'no-gpu' } };
    }
    const detailed = await run('nvidia-smi', ['-q', '-d', 'TEMPERATURE'], timeoutMs);
    if (detailed.stdout !== undefined) parseMemoryTemp(detailed.stdout, gpus);
    return { ok: true, ts: new Date().toISOString(), gpus };
  }

  async function refresh(force) {
    const startedAt = Date.now();
    if (!force && startedAt - lastAttempt < Math.min(pollIntervalMs, 2_000)) return snapshot;
    if (inFlight !== null) return inFlight;
    lastAttempt = startedAt;
    inFlight = (async () => {
      try {
        snapshot = Object.freeze(await poll());
      } catch (error) {
        snapshot = Object.freeze({
          ok: false,
          ts: new Date().toISOString(),
          gpus: [],
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        inFlight = null;
      }
      return snapshot;
    })();
    return inFlight;
  }

  ctx.effect(() => {
    void refresh(true);
    const timer = setInterval(() => {
      void refresh(false);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, 'gpu-temp: poll');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        resource: async (request) => {
          const force = new URL(request.url).searchParams.get('force') === '1';
          if (force) await refresh(true);
          return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          });
        },
      }),
    'gpu-temp: snapshot route',
  );
}
