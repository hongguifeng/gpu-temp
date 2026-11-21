/**
 * Host half of the GPU temperature bundle.
 *
 * Polls `nvidia-smi` for die/memory temperature plus clocks/power/link, reads
 * the motherboard fan channel (nct6798 pwm N), and speaks to the privileged
 * `gpu-fan-control` daemon over its Unix socket so the Web UI can change the
 * fan curve without running as root.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';

/** Read-only snapshot route consumed by the Client half. */
const ROUTE_PATH = '/gpu-temp/state';
/** Fan curve route (GET reads, POST applies). */
const FAN_PATH = '/gpu-temp/fan';
/** Fan daemon socket. */
const DEFAULT_SOCKET = '/run/gpu-fan-control.sock';

/** Supervisor chips the nct6775 driver may bind. */
const HWMON_NAMES = ['nct6798', 'nct6799', 'nct6775', 'nct6776', 'nct6779', 'nct6796'];

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

function findHwmon() {
  let dirs = [];
  try {
    dirs = readdirSync('/sys/class/hwmon', { withFileTypes: true }).map((e) => `/sys/class/hwmon/${e.name}`);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      if (HWMON_NAMES.includes(readFileSync(`${dir}/name`, 'utf8').trim())) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readAttr(dir, name) {
  try {
    return readFileSync(`${dir}/${name}`, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Read the controlled fan channel; null when no Super I/O or channel. */
function readFan(channel) {
  const dir = findHwmon();
  if (dir === null) return null;
  const pwm = num(readAttr(dir, `pwm${channel}`));
  const rpm = num(readAttr(dir, `fan${channel}_input`));
  if (pwm === null) return null;
  return {
    channel,
    pwm,
    duty: Math.round((pwm / 255) * 1000) / 10,
    rpm,
    manual: readAttr(dir, `pwm${channel}_enable`) === '1',
  };
}

/** One request/response line on the fan daemon socket. */
function socketCommand(path, message, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ path });
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'socket timeout' }));
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const line = buffer.split('\n')[0];
      if (line.trim() === '') return;
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, error: 'bad daemon reply' });
      }
    });
    socket.on('error', (error) => finish({ ok: false, error: error.message }));
    socket.on('close', () => finish({ ok: false, error: 'daemon closed' }));
  });
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

/** Normalize the daemon's point list into `t:d,t:d` text. */
function curveText(points) {
  if (!Array.isArray(points)) return '';
  return points.map((p) => `${Number(p[0])}:${Number(p[1])}`).join(',');
}

/**
 * Activate the poller and the routes.
 * @param ctx - Host plugin context.
 * @param config - Resolved row config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const pollIntervalMs = clampNumber(config.pollIntervalMs, 5_000, 1_000, 60_000);
  const timeoutMs = clampNumber(config.timeoutMs, 4_000, 1_000, 30_000);
  const fanChannel = clampNumber(config.fanPwm, 6, 1, 8);
  const socketPath = typeof config.socket === 'string' && config.socket.trim() !== ''
    ? config.socket.trim()
    : DEFAULT_SOCKET;

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
      return { ok: false, ts: new Date().toISOString(), gpus: [], fan: readFan(fanChannel), error: { code: 'exec', message: query.error } };
    }
    const gpus = parseQuery(query.stdout);
    if (gpus.length === 0) {
      return { ok: false, ts: new Date().toISOString(), gpus: [], fan: readFan(fanChannel), error: { code: 'no-gpu' } };
    }
    const detailed = await run('nvidia-smi', ['-q', '-d', 'TEMPERATURE'], timeoutMs);
    if (detailed.stdout !== undefined) parseMemoryTemp(detailed.stdout, gpus);
    const curve = await socketCommand(socketPath, { cmd: 'get_curve' }, 1_000);
    const fan = readFan(fanChannel);
    if (fan !== null) fan.curve = curve.ok === true ? curveText(curve.curve) : null;
    return { ok: true, ts: new Date().toISOString(), gpus, fan };
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
          fan: readFan(fanChannel),
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

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FAN_PATH,
        resource: async (request) => {
          // The web server answers GET/HEAD only; the curve rides in a query
          // parameter because a POST would be refused before reaching us.
          const curve = new URL(request.url).searchParams.get('curve');
          const payload = curve === null
            ? await socketCommand(socketPath, { cmd: 'get_curve' }, 1_000)
            : await socketCommand(socketPath, { cmd: 'set_curve', curve }, 2_000);
          if (curve !== null) await refresh(true);
          return new Response(JSON.stringify(payload), {
            status: payload.ok === true ? 200 : 400,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          });
        },
      }),
    'gpu-temp: fan route',
  );
}
