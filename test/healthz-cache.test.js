import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthBody, createRequestHandler } from '../server/http/routes.js';

function fixture() {
  let scans = 0;
  const counts = { rooms: 625, matches: 300, roomMatches: 250, standaloneMatches: 50,
    humans: 2000, bots: 500, spectators: 12, queued: 8 };
  const health = { startedAt: Date.now() - 10000, network: { connectionCount: 2500 },
    registry: { size: 2600 }, lobby: {
      rooms: new Map([['room', {}]]), activeQueueMatches: new Set([{}]), queueByPlayer: new Map([['p', {}]]),
      stats() { scans++; return { ...counts }; },
    } };
  return { health, counts, scans: () => scans };
}

function response() {
  return {
    headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body) { this.body = body; },
  };
}

test('10000 stable health reads share one scan and the same JSON bytes; expiry refreshes all counts', () => {
  const f = fixture();
  let now = 0;
  const read = createHealthBody(f.health, { now: () => now });
  const first = read();
  for (let i = 0; i < 10000; i++) assert.equal(read(), first);
  assert.equal(f.scans(), 1);
  f.counts.bots = 501;
  f.counts.matches = 301;
  now = 999;
  assert.equal(read(), first);
  now = 1000;
  const next = read();
  assert.notEqual(next, first);
  assert.equal(f.scans(), 2);
  assert.equal(JSON.parse(next).bots, 501);
  assert.equal(JSON.parse(next).matches, 301);
});

test('sockets, sessions and uptime refresh without a room scan; wall-clock changes do not expire counters', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = fixture();
  const read = createHealthBody(f.health, { now: () => 0 });
  read();
  f.health.network.connectionCount++;
  f.health.registry.size++;
  let report = JSON.parse(read());
  assert.equal(report.sockets, 2501);
  assert.equal(report.sessions, 2601);
  t.mock.timers.tick(1000);
  report = JSON.parse(read());
  assert.equal(report.uptimeSec, 11);
  assert.equal(f.scans(), 1);
});

test('room, active match and queue cardinality changes invalidate within the cache interval; servers are isolated', () => {
  const a = fixture(), b = fixture();
  const readA = createHealthBody(a.health, { now: () => 0 });
  const readB = createHealthBody(b.health, { now: () => 0 });
  readA(); readB();
  a.counts.rooms++;
  a.health.lobby.rooms.set('new', {});
  assert.equal(JSON.parse(readA()).rooms, 626);
  a.counts.standaloneMatches++;
  a.health.lobby.activeQueueMatches.add({});
  assert.equal(JSON.parse(readA()).standaloneMatches, 51);
  a.counts.queued++;
  a.health.lobby.queueByPlayer.set('new', {});
  assert.equal(JSON.parse(readA()).queued, 9);
  assert.equal(a.scans(), 4);
  assert.equal(JSON.parse(readB()).rooms, 625);
  assert.equal(b.scans(), 1);
});

test('GET/HEAD health routes bypass async APIs, share bytes and retain headers and method rules', async () => {
  const f = fixture();
  let apiCalls = 0, staticCalls = 0;
  const handler = createRequestHandler({ health: f.health, log: { error: assert.fail },
    serveApi: async () => { apiCalls++; return false; },
    serveStatic: async (_req, res) => { staticCalls++; res.end(); } });
  const get = response(), head = response(), query = response();
  handler({ url: '/healthz', method: 'GET' }, get);
  handler({ url: '/healthz', method: 'HEAD' }, head);
  handler({ url: '/healthz?probe=1', method: 'GET' }, query);
  assert.equal(get.status, 200, 'common health path completes synchronously');
  assert.equal(head.status, 200);
  assert.equal(query.body, get.body);
  assert.equal(head.body, undefined);
  assert.equal(head.headers['content-length'], get.body.length);
  assert.equal(head.headers['cache-control'], 'no-store');
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.equal(get.headers['referrer-policy'], 'same-origin');
  assert.equal(f.scans(), 1);
  assert.equal(apiCalls, 0);
  assert.equal(staticCalls, 0);

  const rejected = response();
  handler({ url: '/healthz', method: 'POST' }, rejected);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, 'GET, HEAD');
  assert.equal(f.scans(), 1);
  const absolute = response();
  handler({ url: 'http://localhost/healthz?probe=2', method: 'GET' }, absolute);
  await Promise.resolve();
  assert.equal(absolute.status, 200);
  assert.equal(apiCalls, 0);
  const long = response();
  handler({ url: '/healthz?' + 'a'.repeat(4096), method: 'GET' }, long);
  await Promise.resolve();
  assert.equal(long.status, 414);
  const other = response();
  handler({ url: '/healthz-extra', method: 'GET' }, other);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(apiCalls, 1);
  assert.equal(staticCalls, 1);
});

test('a failed stats refresh returns 500 and retries instead of caching a false healthy response', () => {
  const f = fixture();
  let failed = true, logged = 0;
  const original = f.health.lobby.stats;
  f.health.lobby.stats = () => { if (failed) throw new Error('stats failed'); return original(); };
  const handler = createRequestHandler({ health: f.health, serveStatic: async () => {},
    log: { error() { logged++; } } });
  const error = response();
  handler({ url: '/healthz', method: 'GET' }, error);
  assert.equal(error.status, 500);
  assert.equal(logged, 1);
  failed = false;
  const ok = response();
  handler({ url: '/healthz', method: 'GET' }, ok);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
});
