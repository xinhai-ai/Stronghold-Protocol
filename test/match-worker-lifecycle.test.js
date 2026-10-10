import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { Persister, restoreServer, snapshotServer } from '../server/persist.js';
import { snapshotMatch } from '../server/match/snapshot.js';
import { DATA, makeMatch } from './match/harness.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const character = DATA.chess.chess_char_1_06_a.charId;
const ops = { [character]: { potential: 2, cultivate: 1 } };
const options = (code = 'TEST') => ({
  roomCode: code, mode: 'solo', difficulty: 'NORMAL', seed: 42, matchNo: 1,
  seats: [{ seat: 0, playerId: 'p_0', name: 'Test', isBot: false, connected: true }],
});

function poolFor(t, config = {}) {
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1, log: quiet, ...config });
  t.after(() => pool.close());
  return pool;
}

function environment(t, { pool = null, mode = 'solo' } = {}) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, getData: () => DATA, log: quiet, matchWorkerPool: pool });
  t.after(() => lobby.shutdown());
  const a = registry.create('A');
  a.connected = true;
  if (mode) lobby.create(a, { mode, difficulty: 'NORMAL' });
  return { registry, lobby, a, room: lobby.roomOf(a) };
}

const rawCall = (match, method) => match.lane.request({
  type: 'call', key: match.key, instanceId: match.instanceId, method, args: [],
});

test('disposed/released matches are deleted inside the Worker, not merely hidden by the proxy', async (t) => {
  const pool = poolFor(t);
  const match = await pool.create('LEAK', options());
  await match.start();
  await match.dispose();
  pool.release('LEAK', match);
  assert.equal(pool.stats().rooms, 0);
  await assert.rejects(rawCall(match, 'publicView'), /unknown match/);
});

test('room-code reuse isolates late callbacks and disposal from the previous match generation', async (t) => {
  const pool = poolFor(t);
  const old = await pool.create('SAME', options());
  await old.start();
  pool.release('SAME', old); // Dispose is intentionally still queued.
  const fresh = await pool.create('SAME', { ...options(), seed: 43 });
  await fresh.start();
  await old.dispose();
  pool.release('SAME', old);
  pool.onMessage(fresh.lane, { type: 'broadcast', key: 'SAME', instanceId: old.instanceId,
    msg: { t: 'm.public', phase: 'STALE' } });
  assert.equal(fresh.publicView().phase, 'INFO_CHECK');
  assert.equal((await fresh.snapshot()).seed, 43);
  assert.equal(pool.stats().rooms, 1);
  await assert.rejects(rawCall(old, 'dispose'), /unknown match/);
  assert.ok(await fresh.snapshot());
});

test('duplicate pool initialization rejects without replacing the first assigned proxy', async (t) => {
  const pool = poolFor(t);
  const first = pool.create('DUP', options());
  await assert.rejects(pool.create('DUP', options()), /already assigned/);
  const match = await first;
  assert.equal(match.lane.matches.get('DUP'), match);
  await match.start();
  assert.ok(await match.snapshot());
});

test('concurrent room.start over real WebSockets starts exactly one Worker match', async (t) => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, matchWorkers: 1, store: null });
  t.after(() => srv.close());
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => c.close());
  await c.hello('Race');
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const code = (await c.waitFor('room.state')).code;
  // Assert ownership, not a cold-Worker startup latency SLA under the full suite's CPU contention.
  const replies = await Promise.all([c.request({ t: 'room.start' }, 10000), c.request({ t: 'room.start' }, 10000)]);
  assert.equal(replies.filter((r) => r.t === 'ok').length, 1);
  assert.equal(replies.find((r) => r.t === 'error').code, ERR.ROOM_STARTED);
  assert.equal(srv.lobby.getRoom(code).matchCount, 1);
});

test('leaving during init cancels the room start and disposes the reserved Worker match', async (t) => {
  const pool = poolFor(t);
  const { lobby, a, room } = environment(t, { pool });
  const starting = lobby.start(a);
  const match = room.match;
  assert.equal(match.ready, false);
  lobby.removeMember(room, a.playerId);
  assert.ok((await starting).error);
  await match.dispose();
  assert.equal(lobby.rooms.has(room.code), false);
  assert.equal(room.match, null);
  assert.equal(lobby.persistenceMatches().length, 0);
  assert.equal(pool.stats().rooms, 0);
  await assert.rejects(rawCall(match, 'snapshot'), /unknown match/);
});

test('failed initialization rolls back the reservation without deleting the previous result replay', async (t) => {
  const pool = poolFor(t, { data: { ...DATA, invalid: () => {} } });
  const { lobby, a, room } = environment(t, { pool });
  const replay = { publicFrame: 'previous', frames: new Map(), pending: new Set() };
  room.replay = replay;
  assert.ok((await lobby.start(a)).error);
  assert.equal(room.match, null);
  assert.equal(room.matchCtx, null);
  assert.equal(room.matchCount, 0);
  assert.equal(room.replay, replay);
  assert.equal(pool.stats().rooms, 0);
});

test('a failed queued launch closes the old queue UI over WS instead of leaving it waiting forever', async (t) => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, matchWorkers: 1, store: null,
    matchmakingWaitMs: 1, matchmakingTickMs: 10 });
  t.after(() => srv.close());
  await srv.matchWorkerPool.lanes[0].worker.terminate();
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => c.close());
  const identity = await c.hello('Queue fail');
  assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const closed = await c.waitFor('match.queue', (m) => m.status === 'closed');
  assert.equal(closed.reason, 'start_failed');
  assert.equal(srv.lobby.queueByPlayer.has(identity.playerId), false);
  assert.equal(srv.lobby.activeQueueMatches.size, 0);
});

test('queue init reserves identities immediately; all departures cancel instead of creating an orphan match', async (t) => {
  const pool = poolFor(t);
  const { lobby, registry, a } = environment(t, { pool, mode: null });
  const b = registry.create('B');
  b.connected = true;
  const starting = lobby.startQueuedMatch({ mode: 'coop', difficulty: 'NORMAL' },
    [a, b].map((s, i) => lobby.humanSeat(i, s)), []);
  const ctx = a.activeMatchCtx;
  assert.ok(ctx?.match);
  assert.equal(lobby.matchJoin(a, { mode: 'coop', difficulty: 'NORMAL' }).error, ERR.ROOM_STARTED);
  lobby.leaveQueuedMatchPlayer(ctx, a.playerId);
  lobby.leaveQueuedMatchPlayer(ctx, b.playerId);
  assert.ok((await starting).error);
  await ctx.match.dispose();
  assert.equal(lobby.activeQueueMatches.size, 0);
  assert.equal(a.activeMatchCtx, null);
  assert.equal(b.activeMatchCtx, null);
  assert.equal(pool.stats().rooms, 0);
  await assert.rejects(rawCall(ctx.match, 'snapshot'), /unknown match/);
});

for (const remote of [false, true]) {
  test(`room matchmaking carries operator settings and AI-last into ${remote ? 'Worker' : 'local'} matches`, async (t) => {
    const pool = remote ? poolFor(t) : null;
    const { lobby, a, room } = environment(t, { pool, mode: 'coop' });
    a.ops = ops;
    room.seatOf(a.playerId).ops = ops;
    room.aiPicksLast = true;
    assert.equal(lobby.matchJoin(a, { mode: 'coop', difficulty: 'NORMAL', fillBots: true }).ok, true);
    const ticket = a.matchQueue;
    assert.deepEqual(ticket.players[0].ops, ops);
    lobby.removeQueueReferences(ticket);
    const seats = [...ticket.players, { seat: 1, playerId: 'ai_test', name: 'AI', isBot: true, connected: true }];
    assert.equal((await lobby.startQueuedMatch(ticket, seats, [])).ok, true);
    const cp = remote ? await room.match.snapshot() : snapshotMatch(room.match);
    assert.deepEqual(cp.players.find((p) => p.playerId === a.playerId).ops, ops);
    assert.equal(cp.aiPicksLast, true);
  });
}

test('failed lane rejects promptly while persistence keeps its checkpoint and saves healthy matches', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t, { lanes: 2 });
  const dead = await pool.create('DEAD', options('DEAD'));
  const live = await pool.create('LIVE', options('LIVE'));
  await dead.start();
  await live.start();
  const docs = [];
  const persister = new Persister({
    registry: { all: () => [] },
    lobby: { rooms: new Map(), persistenceMatches: () => [{ key: 'DEAD', match: dead }, { key: 'LIVE', match: live }] },
    store: { async saveSerialized(bytes) { docs.push(JSON.parse(bytes.toString())); return true; } }, log: quiet,
  });
  t.after(() => persister.encoder.close());
  assert.equal(await persister.flush('before'), true);
  await dead.lane.worker.terminate();
  await assert.rejects(dead.snapshot(), /exited/);
  assert.equal(pool.stats().failedLanes, 1);
  assert.equal((await live.setLoadout('p_0', {}, ops)).ok, true);
  assert.equal(await persister.flush('after'), true);
  assert.deepEqual(docs[1].matches.DEAD, docs[0].matches.DEAD);
  assert.deepEqual(docs[1].matches.LIVE.players[0].ops, ops);
  const next = await pool.create('NEXT', options());
  assert.equal(next.lane, live.lane, 'new games never use a dead lane');
  assert.equal(await persister.shutdown('shutdown-after-crash'), true);
  assert.deepEqual(docs[2].matches.DEAD, docs[0].matches.DEAD);
});

test('unexpected clean exit also closes a lane and refuses new games without hanging', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t);
  const match = await pool.create('EXIT', options());
  const exited = once(match.lane.worker, 'exit');
  match.lane.worker.postMessage({ type: 'shutdown' });
  await exited;
  await assert.rejects(match.snapshot(), /exited 0/);
  await assert.rejects(pool.create('NEXT', options()), /no healthy/);
});

const hangWorker = new URL('./fixtures/match-worker-hang.mjs', import.meta.url);
test('unresponsive Match commands time out and settle queued commands', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t, { workerUrl: hangWorker, timeoutMs: 5000 });
  const match = await pool.create('HANG', options());
  pool.timeoutMs = 30;
  await Promise.all([
    assert.rejects(match.captureSnapshot(), /timed out/),
    assert.rejects(match.snapshot(), /timed out/),
  ]);
  assert.equal(match.lane.pending.size, 0);
  assert.equal(pool.stats().failedLanes, 1);
});

test('pool close settles in-flight commands and commands waiting on the per-match queue', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t, { workerUrl: hangWorker });
  const match = await pool.create('CLOSE', options());
  const first = assert.rejects(match.snapshot(), /pool closed/);
  const second = assert.rejects(match.captureSnapshot(), /pool closed/);
  await nextTurn();
  assert.equal(match.lane.pending.size, 1);
  await pool.close();
  await Promise.all([first, second]);
  assert.equal(match.lane.pending.size, 0);
});

test('postMessage clone errors release requests and do not poison a healthy lane', async (t) => {
  const pool = poolFor(t);
  const match = await pool.create('CLONE', options());
  await match.start();
  await assert.rejects(match.handle('p_0', { t: 'g.infoReady', invalid: () => {} }), { name: 'DataCloneError' });
  assert.equal(match.lane.pending.size, 0);
  assert.equal(pool.stats().failedLanes, 0);
  assert.ok(await match.snapshot());
});

test('uncloneable Worker replies reject the command without timing out or killing the lane', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t);
  const match = await pool.create('REPLY', options());
  await match.start();
  // A Node timer handle contains functions and cannot cross IPC; disposal cancels the tracked timer.
  await assert.rejects(match.invoke('later', 60000, null), /could not be cloned/);
  assert.equal(match.lane.pending.size, 0);
  assert.equal(pool.stats().failedLanes, 0);
  assert.ok(await match.snapshot());
});

test('rejected checkpoint initialization deletes the Worker instance and its parent assignment', async (t) => {
  const pool = poolFor(t);
  let failed;
  await assert.rejects(pool.create('BAD', options(), { created: (match) => { failed = match; } },
    { v: 1, phase: 'INFO_CHECK', players: [] }), /checkpoint refused/);
  assert.equal(pool.stats().rooms, 0);
  assert.equal(pool.assignments.size, 0);
  await assert.rejects(rawCall(failed, 'publicView'), /unknown match/);
});

for (const queue of [false, true]) {
  test(`partial recovery ending a ${queue ? 'queue' : 'normal room'} Worker preserves settlement and clears the running match`, async (t) => {
    const first = environment(t, { mode: 'coop' });
    const b = first.registry.create('B');
    b.connected = true;
    first.lobby.join(b, { code: first.room.code });
    const h = makeMatch({ mode: 'coop', seats: first.room.seats.filter(Boolean), fake: true });
    t.after(() => h.m.dispose());
    h.start();
    h.toPrep();
    const cp = snapshotMatch(h.m);
    const eliminated = cp.players.find((p) => p.playerId === first.a.playerId);
    eliminated.alive = false;
    eliminated.lp = 0;
    first.room.match = h.m;
    first.room.matchCtx = { match: h.m, queue, room: first.room };
    const doc = snapshotServer({ ...first, matchDocs: new Map([[first.room.code, cp]]) });
    doc.sessions = doc.sessions.filter((s) => s.playerId !== b.playerId);
    const pool = poolFor(t);
    const back = environment(t, { pool, mode: null });
    const initial = restoreServer({ doc, ...back, log: quiet });
    const stats = initial.ready ? await initial.ready : initial;
    assert.equal(stats.matches, 1);
    const room = back.lobby.getRoom(first.room.code);
    assert.equal(room.match, null);
    const frames = back.registry.byToken(first.a.token).pendingResult.map((frame) => JSON.parse(frame));
    assert.ok(frames.some((frame) => frame.t === 'm.result'));
    assert.ok(frames.some((frame) => frame.t === 'm.public' && frame.phase === 'RESULT'));
    await nextTurn();
    assert.equal(pool.stats().rooms, 0);
  });
}

test('an unacknowledged queue departure survives a Worker crash and the next restore', { timeout: 10000 }, async (t) => {
  const pool = poolFor(t);
  const env = environment(t, { pool, mode: null });
  const b = env.registry.create('B');
  b.connected = true;
  await env.lobby.startQueuedMatch({ mode: 'coop', difficulty: 'NORMAL' },
    [env.a, b].map((s, i) => env.lobby.humanSeat(i, s)), []);
  const ctx = env.a.activeMatchCtx;
  const persister = new Persister({ ...env, store: { async save() { return true; } }, log: quiet });
  t.after(() => persister.encoder.close());
  await persister.flush('before');
  await ctx.match.lane.worker.terminate();
  env.lobby.leaveQueuedMatchPlayer(ctx, b.playerId);
  await delay(0); // Rejection of the fire-and-forget lifecycle hook must be observed.
  assert.equal(await persister.flush('after'), true);
  const doc = await persister.document();
  const key = `queue:${ctx.match.roomCode}`;
  assert.deepEqual(doc.matchDepartures[key], [b.playerId]);
  const back = environment(t, { mode: null });
  const stats = restoreServer({ doc, ...back, log: quiet });
  assert.equal(stats.matches, 1);
  const restored = back.registry.byToken(env.a.token).activeMatchCtx;
  assert.equal(restored.match.players.get(b.playerId).left, true);
  assert.equal(back.lobby.activeMatchOf(back.registry.byToken(b.token)), null);
});
