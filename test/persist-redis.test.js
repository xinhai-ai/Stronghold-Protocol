// test/persist-redis.test.js — the Redis store against a *real* server (server/redis.js). Skipped when no Redis answers
// on SP_TEST_REDIS_URL / 127.0.0.1:6379, so the suite stays green on a machine without one.
//
// The tests use a throwaway key prefix and clean up after themselves; nothing else in the database is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { StateStore, parseRedisConfig, openStoreFromEnv } from '../server/redis.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { DATA, makeMatch } from './match/harness.js';
import { snapshotMatch } from '../server/match/snapshot.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const REDIS_URL = process.env.SP_TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';

/** Is a TCP port answering? (fast, so an absent Redis skips instead of clamping the suite) */
function reachable(url) {
  return new Promise((resolve) => {
    let opts;
    try {
      const u = new URL(url);
      opts = { host: u.hostname, port: Number(u.port) || 6379 };
    } catch { resolve(false); return; }
    const sock = net.connect({ ...opts, timeout: 400 });
    const done = (ok) => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const available = await reachable(REDIS_URL);
const PREFIX = `sptest:${process.pid}:${Date.now().toString(36)}:`;

function store(name = 'state') {
  return new StateStore({ url: REDIS_URL, prefix: PREFIX, ttlSec: 120, name, log: quietLog });
}

// ---------------------------------------------------------------------------------------------------
// configuration (no Redis needed)
// ---------------------------------------------------------------------------------------------------

test('parseRedisConfig reads the environment and ignores nonsense', () => {
  assert.equal(parseRedisConfig({}), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: '' }), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'not-a-url' }), null);
  const a = parseRedisConfig({ SP_REDIS_URL: 'redis://redis:6379/0' });
  assert.deepEqual(a, { url: 'redis://redis:6379/0', prefix: 'stronghold:', ttlSec: 90_000 });
  const b = parseRedisConfig({ REDIS_URL: 'rediss://user:pw@host:6380/2', SP_REDIS_PREFIX: 'sp:', SP_REDIS_TTL: '3600' });
  assert.equal(b.url, 'rediss://user:pw@host:6380/2');
  assert.equal(b.prefix, 'sp:');
  assert.equal(b.ttlSec, 3600);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'redis://h:1', SP_REDIS_TTL: '5' }).ttlSec, 90_000, 'a short TTL falls back');
  assert.equal(openStoreFromEnv({ env: {} }), null);
  const s = openStoreFromEnv({ env: { SP_REDIS_URL: 'redis://h:1' }, log: quietLog });
  assert.ok(s instanceof StateStore);
  assert.equal(s.key, 'stronghold:state');
  assert.equal(s.label, 'redis://h:1');
});

test('a store that cannot connect degrades instead of throwing or hanging', async () => {
  // port 1 never answers: the connect attempt must give up on its own (node-redis would otherwise retry forever)
  const dead = new StateStore({ url: 'redis://127.0.0.1:1/0', prefix: PREFIX, log: quietLog, connectTimeoutMs: 400, commandTimeoutMs: 400 });
  const started = Date.now();
  assert.equal(await dead.load({ attempts: 1, retryMs: 10 }), null);
  assert.equal(await dead.save({ a: 1 }), false);
  assert.ok(dead.failures > 0, 'the failure was recorded');
  assert.ok(Date.now() - started < 5000, `gave up quickly (${Date.now() - started} ms)`);
  await dead.close();
});

// ---------------------------------------------------------------------------------------------------
// against a real Redis
// ---------------------------------------------------------------------------------------------------

test('save/load round trip, TTL and clear', { skip: !available && `no Redis at ${REDIS_URL}` }, async () => {
  const s = store('roundtrip');
  try {
    assert.equal(await s.load(), null, 'nothing saved yet');
    const doc = { v: 1, rooms: [{ code: 'ABCD' }], nested: { list: [1, 2, { deep: true }] }, text: '卫戍协议' };
    assert.equal(await s.save(doc), true);
    assert.deepEqual(await s.load(), doc);
    const raw = await s.client.ttl(s.key);
    assert.ok(raw > 0 && raw <= 120, `ttl is set (${raw})`);
    assert.equal(await s.clear(), true);
    assert.equal(await s.load(), null);
  } finally {
    await s.clear();
    await s.close();
  }
});

test('a restart through Redis keeps rooms and tokens', { skip: !available && `no Redis at ${REDIS_URL}` }, async (t) => {
  // startServer owns the store it is given (it closes it on shutdown), so every boot gets its own handle
  const servers = [];
  const cleanup = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store: store('server'), MatchClass: StubMatch, log: quietLog });
    servers.push(srv);
    return srv;
  };
  const probe = () => { const p = store('server'); cleanup.push(p); return p; };
  t.after(async () => {
    for (const srv of servers) await srv.close().catch(() => {});
    for (const p of cleanup) { await p.clear().catch(() => {}); await p.close().catch(() => {}); }
  });

  const srvA = await boot();
  const c1 = await TestClient.connect(`ws://127.0.0.1:${srvA.port}/ws`);
  const w1 = await c1.hello('Redis Alice');
  const c2 = await TestClient.connect(`ws://127.0.0.1:${srvA.port}/ws`);
  const w2 = await c2.hello('Redis Bob');
  assert.equal((await c1.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const code = (await c1.waitFor('room.state')).code;
  await c2.request({ t: 'room.join', code });
  await c1.waitFor('room.state', (x) => x.seats.filter(Boolean).length === 2);
  await c1.close();
  await c2.close();
  await srvA.close();

  // the document is really in Redis (not only in the process that wrote it)
  const stored = await probe().load();
  assert.ok(stored, 'the shutdown flushed the state into Redis');
  assert.equal(stored.v, 1);
  assert.equal(stored.rooms[0].code, code);
  assert.equal(stored.sessions.length, 2);

  const srvB = await boot();
  const back = await TestClient.connect(`ws://127.0.0.1:${srvB.port}/ws`);
  const w = await back.hello('Redis Alice', w1.token);
  assert.equal(w.resumed, true);
  assert.equal(w.playerId, w1.playerId);
  const state = await back.waitFor('room.state');
  assert.equal(state.code, code);
  assert.equal(state.seats.filter(Boolean).length, 2);
  assert.equal(state.hostId, w1.playerId);
  const other = await TestClient.connect(`ws://127.0.0.1:${srvB.port}/ws`);
  const wOther = await other.hello('Redis Bob', w2.token);
  assert.equal(wOther.playerId, w2.playerId);
  await back.waitFor('room.state', (x) => x.seats.filter(Boolean).length === 2);
  await back.close();
  await other.close();
});

test('Match Workers keep independent rooms, tokens and checkpoints through two real Redis restarts',
  { skip: !available && `no Redis at ${REDIS_URL}`, timeout: 30000 }, async (t) => {
    const servers = [], clients = [], identities = [];
    const boot = async () => {
      const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, matchWorkers: 2,
        store: store('match-workers'), log: quietLog });
      servers.push(srv);
      return srv;
    };
    t.after(async () => {
      await Promise.all(clients.map((c) => c.terminate()));
      for (const srv of servers) await srv.close().catch(() => {});
      const cleanup = store('match-workers');
      try { await cleanup.clear(); } finally { await cleanup.close(); }
    });
    let srv = await boot();
    const connect = async (name, token) => {
      const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(client);
      const welcome = await client.hello(name, token, { stateDelta: 1 });
      return { client, welcome };
    };
    for (let roomIndex = 0; roomIndex < 2; roomIndex++) {
      const players = [];
      for (let seat = 0; seat < 4; seat++) players.push(await connect(`Room${roomIndex}Seat${seat}`));
      const host = players[0].client;
      await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      const code = (await host.waitFor('room.state')).code;
      for (const { client } of players.slice(1)) {
        await client.request({ t: 'room.join', code });
        await client.request({ t: 'room.ready', ready: true });
      }
      assert.equal((await host.request({ t: 'room.start' }, 10000)).t, 'ok');
      const seed = srv.lobby.rooms.get(code).match.seed;
      for (const { client, welcome } of players) {
        const state = await client.waitFor('m.state', (m) => m.kind === 'm.private' && m.full);
        assert.equal(state.full.playerId, welcome.playerId);
        identities.push({ code, seed, token: welcome.token, playerId: welcome.playerId });
      }
    }
    assert.deepEqual(srv.matchWorkerPool.stats().lanes.map((lane) => lane.rooms), [1, 1]);
    for (let restart = 0; restart < 2; restart++) {
      await srv.persister.flush('worker-restart-test');
      await Promise.all(clients.map((c) => c.terminate()));
      await srv.close();
      srv = await boot();
      assert.equal(srv.matchWorkerPool.stats().rooms, 2);
      for (const identity of identities) {
        const match = srv.lobby.rooms.get(identity.code).match;
        assert.equal(match.remote, true);
        assert.equal(match.seed, identity.seed);
        const { client, welcome } = await connect('Back', identity.token);
        assert.equal(welcome.resumed, true);
        assert.equal(welcome.playerId, identity.playerId);
        assert.equal((await client.waitFor('m.state', (m) => m.kind === 'm.private' && m.full)).full.playerId, identity.playerId);
        assert.ok((await client.waitFor('m.state', (m) => m.kind === 'm.public' && m.full)).full);
        // State callbacks can reach the socket before onReconnect's IPC reply updates the proxy metadata.
        // A subsequent queued snapshot is a lifecycle barrier, not an assumption about socket/IPC scheduling.
        const checkpoint = await match.snapshot();
        assert.equal(match.order.find((p) => p.playerId === identity.playerId).connected, true);
        assert.equal(checkpoint.players.filter((p) => !p.left).length, 4);
      }
    }
  });

test('unreadable Redis JSON is preserved instead of overwritten by periodic or shutdown writes', { skip: !available && `no Redis at ${REDIS_URL}` }, async () => {
  const probe = store('invalid-json');
  let srv;
  const raw = '{"broken":';
  try {
    assert.equal(await probe.saveSerialized(raw), true);
    assert.equal(await probe.load(), null);
    assert.equal(probe.loadState, 'invalid');
    srv = await startServer({ port: 0, quiet: true, store: store('invalid-json'), MatchClass: StubMatch, log: quietLog });
    assert.equal(await srv.persister.flush('test'), false);
    await srv.close();
    assert.equal(await probe.client.get(probe.key), raw);
  } finally {
    await srv?.close();
    await probe.clear();
    await probe.close();
  }
});

test('complete Worker matches preserve tokens and checkpoint state through three real Redis restarts',
  { skip: !available && `no Redis at ${REDIS_URL}`, timeout: 30000 }, async (t) => {
    const servers = [], clients = [];
    const probe = store('worker-restarts');
    t.after(async () => {
      for (const c of clients) await c.close().catch(() => {});
      for (const srv of servers) await srv.close().catch(() => {});
      await probe.clear();
      await probe.close();
    });
    const boot = async () => {
      const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, log: quietLog,
        workers: 0, matchWorkers: 1, store: store('worker-restarts') });
      servers.push(srv);
      return srv;
    };
    const connect = async (srv) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      return c;
    };
    let srv = await boot();
    let c = await connect(srv);
    const identity = await c.hello('Worker Redis');
    await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const code = (await c.waitFor('room.state')).code;
    await c.request({ t: 'room.start' }, 10000);
    await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    const before = await srv.lobby.getRoom(code).match.snapshot();
    let sequence = before._battleSeq;
    for (let restart = 0; restart < 3; restart++) {
      assert.equal(await srv.persister.flush('worker-restart'), true);
      await c.close();
      await srv.close();
      assert.ok((await probe.load()).matches[code], 'the checkpoint really reached Redis');
      srv = await boot();
      c = await connect(srv);
      const identityAfter = await c.hello('Worker Redis', identity.token);
      assert.equal(identityAfter.resumed, true);
      assert.equal(identityAfter.playerId, identity.playerId);
      await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
      const restored = await srv.lobby.getRoom(code).match.snapshot();
      for (const key of ['seed', 'battlePrefix', 'rng', 'poolLeft', 'factions', 'disabledBonds', 'bannedChess', 'setupRevision']) {
        assert.deepEqual(restored[key], before[key], key);
      }
      assert.ok(restored._battleSeq > sequence);
      sequence = restored._battleSeq;
    }
  });

test('0.2.4 signed shared/private stock and equipment ownership survive two Worker restarts through real Redis',
  { skip: !available && `no Redis at ${REDIS_URL}`, timeout: 30000 }, async (t) => {
    const slot = 'chess_char_6_diy1_a', item = 'chess_item_5_07_e_a';
    const seats = [{ seat: 0, playerId: 'p_0', name: 'Stock', isBot: false, connected: true,
      diy: { [slot]: { charId: 'char_112_siege', skillIndex: 1, uniEquipId: null } } }];
    const h = makeMatch({ mode: 'solo', seats, seed: 11, fake: true }).start();
    const ps = h.ps('p_0'), id = [...h.m.pool.entries.keys()].find(id => h.m.gd.tierOf(id) === 6);
    for (const base of [id, slot]) {
      const stock = ps.poolOf(base);
      for (let i = 0, count = stock.cap(base) + 1; i < count; i++) assert.ok(ps.acquireChess(base, { silent: true }));
      assert.equal(stock.entries.get(base).left, -1);
    }
    assert.ok(ps.acquireItem(item, { silent: true }));
    const before = snapshotMatch(h.m);
    h.m.dispose();
    const probe = store('signed-stock-024'), pools = [];
    t.after(async () => {
      for (const pool of pools) await pool.close();
      try { await probe.clear(); } finally { await probe.close(); }
    });
    assert.equal(await probe.save({ checkpoint: before }), true);
    for (let restart = 0; restart < 2; restart++) {
      const saved = await probe.load();
      assert.ok(saved?.checkpoint);
      const pool = new MatchWorkerPool({ data: DATA, lanes: 1 });
      pools.push(pool);
      const match = await pool.create(`signed-stock-${restart}`, {
        roomCode: 'STCK', mode: 'solo', difficulty: 'NORMAL', seed: 11, matchNo: 1, seats,
      }, {}, saved.checkpoint);
      const restored = await match.snapshot();
      assert.equal(restored.poolLeft[id], -1);
      assert.deepEqual(restored.players[0].diyStock, before.players[0].diyStock);
      assert.deepEqual(restored.players[0].hand, before.players[0].hand);
      assert.deepEqual(restored.players[0].temp, before.players[0].temp);
      assert.equal(await probe.save({ checkpoint: restored }), true);
      await pool.close();
    }
  });
