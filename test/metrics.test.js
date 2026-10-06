import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { probePort } from '../tools/doctor.mjs';

const COUNTERS = ['sockets', 'sessions', 'rooms', 'matches', 'roomMatches', 'standaloneMatches', 'humans', 'bots', 'spectators', 'queued'];
const DIAGNOSTICS = ['persist', 'workers', 'memory', 'staticCache', 'usage', 'socketBuffers', 'announcements', 'websocket',
  'assetsCdn', 'dataCdn', 'limits', 'tuning'];

test('healthz retains metadata and all headline counters; metrics collects the detailed state on demand', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null, announcementsFile: null });
  t.after(() => srv.close());
  const calls = [];
  for (const [owner, method] of [[srv.network, 'usage'], [srv.network, 'bufferedBytes'], [srv.lobby, 'usage'], [srv.announcements, 'stats']]) {
    const original = owner[method].bind(owner);
    owner[method] = (...args) => { calls.push(method); return original(...args); };
  }
  const response = await fetch(srv.url + '/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const health = await response.json();
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'version', 'app', 'uptimeSec', 'build', ...COUNTERS].sort());
  assert.equal(health.ok, true);
  assert.equal(health.app, APP_VERSION);
  assert.equal(health.version, PROTOCOL_VERSION);
  assert.match(health.build, /^[0-9a-f]{12}$/);
  for (const field of COUNTERS) assert.equal(health[field], 0, field);
  assert.deepEqual(calls, [], 'health polling does not collect diagnostics');
  const port = await probePort(srv.port);
  assert.equal(port.state, 'ours', 'launch scripts still recognize the lightweight health response');
  assert.deepEqual(calls, []);

  const metricsResponse = await fetch(srv.url + '/metrics');
  assert.equal(metricsResponse.status, 200);
  assert.equal(metricsResponse.headers.get('cache-control'), 'no-store');
  const metrics = await metricsResponse.json();
  assert.deepEqual(Object.keys(metrics).sort(), [...Object.keys(health), ...DIAGNOSTICS].sort());
  for (const field of ['ok', 'version', 'app', 'build', ...COUNTERS]) assert.equal(metrics[field], health[field], field);
  assert.equal(metrics.persist, null);
  assert.equal(metrics.workers, null);
  assert.ok(metrics.memory.rss > 0);
  assert.ok(metrics.staticCache.gzipBytes <= metrics.staticCache.gzipLimitBytes);
  assert.deepEqual(metrics.socketBuffers, { total: 0, max: 0 });
  assert.deepEqual(calls.sort(), ['usage', 'bufferedBytes', 'usage', 'stats'].sort());
});

test('both monitoring routes support HEAD, reject POST and retain no-store', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null, announcementsFile: null });
  t.after(() => srv.close());
  for (const route of ['/healthz', '/metrics']) {
    const head = await fetch(srv.url + route, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type'), /^application\/json/);
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '');
    const post = await fetch(srv.url + route, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    await post.text();
  }
});

test('metrics retains persistence diagnostics when a state store is configured', async (t) => {
  const store = { label: 'test', async load() { return null; }, async save() { return true; }, async close() {} };
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store, announcementsFile: null });
  t.after(() => srv.close());
  const metrics = await (await fetch(srv.url + '/metrics')).json();
  assert.deepEqual(metrics.persist, { redis: true, writes: 0, checkpoints: 0, snapshotBytes: 0, workerMemory: null });
  assert.equal('persist' in await (await fetch(srv.url + '/healthz')).json(), false);
});
