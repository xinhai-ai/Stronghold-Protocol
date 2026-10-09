import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderMetrics } from './metrics.mjs';

export function validateTargets(input) {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw new Error('targets must contain 1..32 games');
  const names = new Set();
  return input.map((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('invalid target');
    const { name, url, wsUrl } = target;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(name) || names.has(name)) throw new Error('invalid/duplicate game name');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('invalid metrics URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('invalid metrics URL');
    names.add(name);
    if (wsUrl !== undefined) {
      let ws;
      try { ws = new URL(wsUrl); } catch { throw new Error('invalid WS probe URL'); }
      if (!['ws:', 'wss:'].includes(ws.protocol) || ws.username || ws.password || ws.hash) throw new Error('invalid WS probe URL');
    }
    return { name, url: parsed.href, ...(wsUrl ? { wsUrl } : {}) };
  });
}

export async function fetchSnapshot(url, { timeoutMs = 5000, maxBytes = 2 * 1024 * 1024, fetchFn = fetch } = {}) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    headers: { accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('game metrics HTTP error'); }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('metrics too large'); }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('metrics too large');
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  if (data?.ok !== true || typeof data.uptimeSec !== 'number' || !Number.isFinite(data.uptimeSec)
    || !data.websocket?.diagnostics || !data.memory || typeof data.sockets !== 'number') throw new Error('not game metrics JSON');
  return data;
}

/** Synthetic unauthenticated ping only: no token, room, game operation or player data. Not action-state latency. */
export function probeWebSocket(url, { timeoutMs = 5000, WebSocketClass = WebSocket } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    let ws, sentAt, connectSeconds, settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ up: false }), timeoutMs);
    try {
      ws = new WebSocketClass(url);
      ws.addEventListener('open', () => {
        connectSeconds = (performance.now() - start) / 1000;
        sentAt = performance.now();
        ws.send(JSON.stringify({ t: 'ping', c: sentAt, rid: 1 }));
      });
      ws.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 65536) return;
          const msg = JSON.parse(event.data);
          if (msg.t === 'pong' && msg.rid === 1 && msg.c === sentAt) {
            finish({ up: true, connectSeconds, rttSeconds: (performance.now() - sentAt) / 1000 });
          }
        } catch { /* ignore unrelated/non-JSON messages */ }
      });
      ws.addEventListener('error', () => finish({ up: false }));
      ws.addEventListener('close', () => finish({ up: false }));
    } catch { finish({ up: false }); }
  });
}

/** Poll fixed configured URLs only; Prometheus cannot use a request parameter to turn this into an SSRF proxy. */
export async function startExporter({ targets, host = '127.0.0.1', port = 9108, intervalMs = 10000, timeoutMs = 5000,
  fetchFn = fetch, now = () => Date.now() / 1000 } = {}) {
  targets = validateTargets(targets);
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs >= intervalMs) {
    throw new Error('invalid polling intervals');
  }
  const states = new Map();
  let closed = false, pending = null, timer = null;
  const poll = () => {
    if (closed) return Promise.resolve();
    if (pending) return pending; // no pile-up when the game stalls
    pending = Promise.all(targets.map(async (target) => {
      const previous = states.get(target.name) || { errors: 0 }, start = performance.now();
      const probePromise = target.wsUrl ? probeWebSocket(target.wsUrl, { timeoutMs }) : Promise.resolve(undefined);
      let next;
      try {
        const data = await fetchSnapshot(target.url, { timeoutMs, fetchFn });
        next = { data, up: true, errors: previous.errors, lastSuccess: now(),
          durationSeconds: (performance.now() - start) / 1000 };
      } catch {
        // Only aggregate failure count; no URL/token/body/address in logs or labels.
        next = { up: false, errors: previous.errors + 1, lastSuccess: previous.lastSuccess,
          durationSeconds: (performance.now() - start) / 1000 };
      }
      next.probe = await probePromise;
      states.set(target.name, next);
    })).finally(() => { pending = null; });
    return pending;
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); res.end(); return; }
    if (path !== '/metrics' && path !== '/healthz') { res.writeHead(404); res.end(); return; }
    const body = path === '/metrics' ? renderMetrics(targets, states, now()) : JSON.stringify({ ok: !closed });
    const bytes = Buffer.from(body);
    res.writeHead(200, { 'Content-Type': path === '/metrics' ? 'text/plain; version=0.0.4; charset=utf-8' : 'application/json',
      'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  timer = setInterval(poll, intervalMs);
  timer.unref?.();
  const ready = poll();
  return { server, states, poll, ready, url: `http://${host}:${server.address().port}`,
    async close() {
      closed = true; clearInterval(timer);
      const finishing = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.all([pending, finishing]);
    } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const targets = JSON.parse(await fs.readFile(process.env.SP_MONITOR_TARGETS_FILE || '/etc/stronghold/targets.json', 'utf8'));
    const exporter = await startExporter({ targets, host: process.env.HOST || '0.0.0.0',
      port: Number(process.env.PORT || 9108), intervalMs: Number(process.env.SP_MONITOR_INTERVAL_MS || 10000),
      timeoutMs: Number(process.env.SP_MONITOR_TIMEOUT_MS || 5000) });
    console.log(`[monitor] JSON collector ready for ${targets.length} game(s); no game identities collected`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => exporter.close().then(() => process.exit(0)));
  } catch {
    console.error('[monitor] startup failed; check target JSON, intervals, port and mount readability (configuration not logged)');
    process.exitCode = 1;
  }
}
