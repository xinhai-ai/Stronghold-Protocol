import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { renderMetrics } from '../deploy/monitoring/exporter/metrics.mjs';
import { fetchSnapshot, probeWebSocket, startExporter, validateTargets } from '../deploy/monitoring/exporter/index.mjs';
import { startServer } from '../server/index.js';
import { C2S } from '../shared/protocol.js';

const sample = {
  ok: true, app: '0.2.1', build: 'abc', uptimeSec: 10, sockets: 2, sessions: 2, rooms: 1, matches: 1,
  roomMatches: 1, standaloneMatches: 0, humans: 2, bots: 0, spectators: 0, queued: 0,
  memory: { rss: 100, heapUsed: 50, heapTotal: 90, external: 5, arrayBuffers: 1 },
  socketBuffers: { total: 0, max: 0 }, staticCache: { gzipBytes: 1, gzipLimitBytes: 2 },
  workers: { size: 2, busy: 0, queued: 0, maxQueue: 4, avgComputeMs: 3, submitted: 4, completed: 4, failed: 0, cancelled: 0, rejected: 0, queueMs: 5, computeMs: 12, memory: [] },
  persist: { redis: true, writes: 3, checkpoints: 1, snapshotBytes: 8, workerMemory: { heapUsed: 4, heapTotal: 5 } },
  websocket: { compression: true, diagnostics: {
    eventLoop: { utilization: 0.1, meanMs: 20, maxMs: 60, p95Ms: 30, p99Ms: 50 },
    recentEventLoop: { sampledAt: 1000, windowMs: 10000, sampleCount: 500, utilization: 0.2, meanMs: 21, maxMs: 90, p95Ms: 40, p99Ms: 70 },
    processCpu: { userSeconds: 2, systemSeconds: 1 }, receivedFrames: 3, sentFrames: 4,
    receivedBytes: 5, sentBytes: 6, droppedSnapshots: 0, slowDisconnects: 0,
    sendCompletionMs: { count: 2, sumMs: 4, p95UpperMs: 4, buckets: [{ leMs: 1, count: 1 }, { leMs: '+Inf', count: 2 }] },
    handlerMs: { 'g.ready': { count: 2, sumMs: 3, p95UpperMs: 2, buckets: [{ leMs: 1, count: 1 }, { leMs: '+Inf', count: 2 }] } },
  } },
  limits: { maxConnections: 10, maxRooms: 10 }, announcements: { configured: true, loaded: true, configError: null },
};

test('renderMetrics exports recent windows, counters and valid histogram families without untrusted labels', () => {
  const text = renderMetrics([{ name: 'prod', url: 'http://game/metrics' }],
    new Map([['prod', { up: true, data: sample, errors: 0, lastSuccess: 100, durationSeconds: 0.02 }]]), 110);
  assert.match(text, /^sp_players_sockets\{game="prod"\} 2$/m);
  assert.match(text, /^sp_event_loop_window_p99_seconds\{game="prod"\} 0.07$/m);
  assert.match(text, /^sp_ws_send_completion_seconds_bucket\{game="prod",le="\+Inf"\} 2$/m);
  assert.match(text, /^sp_ws_handler_seconds_bucket\{game="prod",message="g\.ready",le="\+Inf"\} 2$/m);
  assert.doesNotMatch(text, /url=|http:\/\/game/);
});

test('targets and fetches are bounded and failures do not expose stale game gauges', async () => {
  assert.throws(() => validateTargets([{ name: 'x', url: 'file:///etc/passwd' }]));
  assert.throws(() => validateTargets([{ name: 'x', url: 'http://u:p@example.com/metrics' }]));
  const body = JSON.stringify(sample);
  const response = { ok: true, headers: new Headers({ 'content-length': String(body.length) }), body: ReadableStream.from([new TextEncoder().encode(body)]) };
  assert.equal((await fetchSnapshot('http://game/metrics', { fetchFn: async () => response })).rooms, 1);
  const states = new Map([['prod', { up: false, errors: 2, lastSuccess: 100 }]]);
  const text = renderMetrics([{ name: 'prod', url: 'http://game/metrics' }], states, 110);
  assert.match(text, /sp_target_up\{game="prod"\} 0/);
  assert.doesNotMatch(text, /sp_players_rooms/);
});

test('exporter polls fixed targets and serves Prometheus/health endpoints', async () => {
  const exporter = await startExporter({ targets: [{ name: 'prod', url: 'http://game/metrics' }],
    port: 0, intervalMs: 5000, timeoutMs: 100, fetchFn: async () => ({ ok: true, headers: new Headers(),
      body: ReadableStream.from([new TextEncoder().encode(JSON.stringify(sample))]) }) });
  try {
    await exporter.ready;
    assert.equal((await (await fetch(exporter.url + '/healthz')).json()).ok, true);
    const metrics = await (await fetch(exporter.url + '/metrics')).text();
    assert.match(metrics, /sp_target_up\{game="prod"\} 1/);
    const head = await fetch(exporter.url + '/metrics', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(exporter.url + '/metrics', { method: 'POST' })).status, 405);
    assert.equal((await fetch(exporter.url + '/unknown')).status, 404);
  } finally { await exporter.close(); }
});

test('legacy JSON exports existing diagnostics but no invented CPU, window, histograms or disabled Worker values', () => {
  const old = structuredClone(sample);
  delete old.websocket.diagnostics.processCpu;
  delete old.websocket.diagnostics.recentEventLoop;
  delete old.websocket.diagnostics.sendCompletionMs.buckets;
  delete old.websocket.diagnostics.handlerMs['g.ready'].buckets;
  old.workers = null; old.persist = null;
  const text = renderMetrics([{ name: 'prod', url: 'http://game/metrics' }], new Map([['prod', { up: true, data: old }]]));
  assert.match(text, /sp_process_cpu_available\{game="prod"\} 0/);
  assert.doesNotMatch(text, /sp_process_cpu_user_seconds_total|sp_worker_size|sp_persist_writes_total|sp_ws_handler_seconds_bucket/);
  assert.match(text, /sp_ws_send_completion_p95_upper_seconds_since_start/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('histograms are well formed, labels are bounded, and two instances cannot merge private data', () => {
  const next = structuredClone(sample);
  next.websocket.diagnostics.handlerMs.secretPlayer = next.websocket.diagnostics.handlerMs['g.ready'];
  const text = renderMetrics([{ name: 'a', url: 'http://game/metrics' }, { name: 'b', url: 'http://game2/metrics' }],
    new Map([['a', { up: true, data: sample }], ['b', { up: true, data: next }]]));
  assert.equal((text.match(/# TYPE sp_ws_handler_seconds histogram/g) || []).length, 1);
  assert.doesNotMatch(text, /message="secretPlayer"/);
  for (const kind of Object.keys(C2S)) {
    const withType = structuredClone(sample);
    withType.websocket.diagnostics.handlerMs = { [kind]: sample.websocket.diagnostics.handlerMs['g.ready'] };
    const output = renderMetrics([{ name: 'a', url: 'http://game/metrics' }], new Map([['a', { up: true, data: withType }]]));
    assert.ok(output.includes(`message="${kind}"`), 'missing fixed protocol type ' + kind);
  }
  const bad = structuredClone(sample);
  bad.websocket.diagnostics.sendCompletionMs.buckets = [{ leMs: 5, count: 1 }, { leMs: 1, count: 2 }, { leMs: '+Inf', count: 2 }];
  const invalid = renderMetrics([{ name: 'a', url: 'http://game/metrics' }], new Map([['a', { up: true, data: bad }]]));
  assert.doesNotMatch(invalid, /sp_ws_send_completion_seconds_bucket/);
});

test('fetch rejects oversized, invalid, redirect and non-game JSON, and enforces no redirect option', async () => {
  const reply = (data) => new Response(data, { status: 200 });
  await assert.rejects(fetchSnapshot('http://game/metrics', { maxBytes: 10, fetchFn: async () => reply('x'.repeat(11)) }), /too large/);
  await assert.rejects(fetchSnapshot('http://game/metrics', { fetchFn: async () => reply('{}') }), /not game/);
  await assert.rejects(fetchSnapshot('http://game/metrics', { fetchFn: async () => reply('bad') }));
  await assert.rejects(fetchSnapshot('http://game/metrics', { fetchFn: async () => new Response(null, { status: 302 }) }), /HTTP/);
  let observed;
  await fetchSnapshot('http://game/metrics', { fetchFn: async (_, options) => {
    observed = options; return reply(JSON.stringify(sample));
  } });
  assert.equal(observed.redirect, 'error');
  assert.ok(observed.signal instanceof AbortSignal);
  assert.throws(() => validateTargets([null]));
  assert.throws(() => validateTargets(Array(33).fill({ name: 'x', url: 'http://game/metrics' })));
  assert.throws(() => validateTargets([{ name: 'x', url: 'http://game' }, { name: 'x', url: 'http://game2' }]));
  assert.throws(() => validateTargets([{ name: 'x', url: 'http://game', wsUrl: 'file:///x' }]));
  assert.throws(() => validateTargets([{ name: 'x', url: 'invalid-secret-address' }]), (error) => {
    assert.ok(!String(error).includes('secret-address'));
    return true;
  });
});

test('polls coalesce, failure removes stale snapshot, and recovery does not retain old errors as up', async () => {
  let release, calls = 0, fail = false, block = true;
  const exporter = await startExporter({ targets: [{ name: 'prod', url: 'http://game/metrics' }], port: 0,
    intervalMs: 5000, timeoutMs: 100, fetchFn: async () => {
      calls++;
      if (block) await new Promise((resolve) => { release = resolve; });
      if (fail) throw new Error('secret URL/token must never be logged');
      return new Response(JSON.stringify(sample));
    } });
  try {
    const a = exporter.poll(), b = exporter.poll();
    assert.equal(a, b);
    assert.equal(calls, 1);
    release(); await exporter.ready; block = false; fail = true;
    await exporter.poll();
    const text = await (await fetch(exporter.url + '/metrics')).text();
    assert.match(text, /sp_target_up\{game="prod"\} 0/);
    assert.match(text, /sp_exporter_scrape_errors_total\{game="prod"\} 1/);
    assert.doesNotMatch(text, /sp_players_sockets|secret/);
    fail = false; await exporter.poll();
    assert.match(await (await fetch(exporter.url + '/metrics')).text(), /sp_target_up\{game="prod"\} 1/);
  } finally { await exporter.close(); }
});

test('actual local game JSON/WS probe integration: no identities or rooms, histogram/window and route compatibility', async (t) => {
  const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null, announcementsFile: null });
  t.after(() => game.close());
  const exporter = await startExporter({ targets: [{ name: 'local', url: game.url + '/metrics',
    wsUrl: `ws://127.0.0.1:${game.port}/ws` }], port: 0 });
  t.after(() => exporter.close());
  await exporter.ready;
  const text = await (await fetch(exporter.url + '/metrics')).text();
  assert.match(text, /sp_ws_probe_up\{game="local"\} 1/);
  assert.match(text, /sp_ws_probe_rtt_seconds/);
  assert.match(text, /sp_process_cpu_user_seconds_total/);
  assert.equal(game.registry.size, 0);
  assert.equal(game.lobby.rooms.size, 0);
  await delay(50);
  game.network.diagnostics.sampleWindow();
  await exporter.poll();
  assert.match(await (await fetch(exporter.url + '/metrics')).text(), /sp_event_loop_window_p99_seconds/);
  const health = await (await fetch(game.url + '/healthz')).json();
  assert.equal('websocket' in health, false);
  assert.equal('processCpu' in health, false);
  const metrics = await (await fetch(game.url + '/metrics')).json();
  assert.equal(metrics.websocket.diagnostics.period, 'sinceStart');
  assert.equal(metrics.websocket.diagnostics.handlerMs.ping.buckets.at(-1).leMs, '+Inf');
});

test('WS probe times out and closes without emitting player operations', async () => {
  const calls = [];
  class SilentWS {
    constructor() { this.callbacks = {}; }
    addEventListener(name, fn) { this.callbacks[name] = fn; if (name === 'open') queueMicrotask(fn); }
    send(data) { calls.push(JSON.parse(data)); }
    close() { calls.push('closed'); }
  }
  const result = await probeWebSocket('ws://fake/ws', { timeoutMs: 25, WebSocketClass: SilentWS });
  assert.equal(result.up, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].t, 'ping');
  assert.equal(calls[1], 'closed');
});

test('provisioned dashboard separates scopes and binds queries to configured datasource/instance', async () => {
  const d = JSON.parse(await readFile(new URL('../deploy/monitoring/grafana/dashboards/stronghold-overview.json', import.meta.url), 'utf8'));
  assert.equal(d.uid, 'stronghold-platform');
  assert.ok(d.panels.length >= 25);
  assert.equal(d.templating.list[0].name, 'game');
  const ids = new Set();
  for (const p of d.panels) {
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    if (['row', 'text'].includes(p.type)) continue;
    assert.equal(p.datasource.uid, 'stronghold-prometheus');
    assert.ok(p.targets.every((target) => !target.expr.includes('sp_') || target.expr.includes('game=~"$game"')));
  }
  assert.ok(d.panels.some((p) => p.type === 'text' && p.options.content.includes('当前没有客户端 RUM')));
  const cpu = d.panels.find((p) => p.title.includes('平均 CPU'));
  assert.equal(cpu.fieldConfig.defaults.unit, 'percent');
  assert.ok(!cpu.targets.some((t) => t.expr.includes('worker_compute')));
});
