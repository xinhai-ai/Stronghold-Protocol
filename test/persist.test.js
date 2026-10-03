// test/persist.test.js — Redis-backed state (server/persist.js, server/redis.js): sessions, rooms and a running match
// survive a restart. The store is an in-memory stand-in here; test/persist-redis.test.js talks to a real Redis when one
// is reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Match as RealMatch } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { snapshotServer, restoreServer, sessionDoc, PERSIST_VERSION } from '../server/persist.js';
import { PHASE } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';
import { FakeBattle } from './match/fakeBattle.js';

/** In-memory StateStore stand-in (same surface: load / save / clear / close). */
class MemoryStore {
  constructor() { this.doc = null; this.writes = 0; }
  async load() { return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null; }
  async save(doc) { this.doc = JSON.parse(JSON.stringify(doc)); this.writes++; return true; }
  async clear() { this.doc = null; }
  async close() {}
  get label() { return 'memory'; }
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * The real engine on a virtual clock, so a live-server test can reach a checkpoint without waiting out real timers.
 * FakeBattle keeps the rounds instant (a real simulation in instant mode would stream thousands of b.snap frames into
 * the test clients, which buffer everything they receive).
 */
class TestMatch extends RealMatch {
  constructor(opts) {
    super({
      ...opts,
      scheduler: new VirtualScheduler({ instantCombat: true }),
      BattleClass: FakeBattle,
      botRehearsal: 0,
      clientCombat: false,
    });
  }
}

/**
 * Advance a virtual-clock match until `pred` holds. Strictly bounded and deliberately short: a runaway callback chain
 * must fail the test (not hang it), and the frames the match broadcasts pile up in the test client's inbox.
 */
function until(match, pred, maxSteps = 20_000) {
  const ok = match.sched.runUntil(pred, { maxSteps });
  assert.ok(ok, `scheduler gave up waiting (phase ${match.phase} round ${match.round})`);
}

async function player(port, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  return c;
}

// ---------------------------------------------------------------------------------------------------
// document round trip (no server)
// ---------------------------------------------------------------------------------------------------

test('a room and its sessions survive a document round trip', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const a = registry.create('Alice');
  const b = registry.create('Bob');
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'HARD' }), { ok: true });
  const code = a.roomCode;
  assert.deepEqual(lobby.join(b, { code }), { ok: true });
  assert.deepEqual(lobby.ready(b, { ready: true }), { ok: true });

  const now = Date.now();
  const doc = snapshotServer({ registry, lobby, now });
  assert.equal(doc.v, PERSIST_VERSION);
  assert.equal(doc.sessions.length, 2);
  assert.equal(doc.rooms.length, 1);
  assert.equal(doc.rooms[0].code, code);
  assert.equal(doc.rooms[0].difficulty, 'HARD');
  assert.equal(doc.rooms[0].seats.length, 2);
  assert.equal(doc.rooms[0].seats.find((s) => s.playerId === b.playerId).ready, true);

  // a second (restarted) server reads it back
  const registry2 = new SessionRegistry();
  const lobby2 = new Lobby({ registry: registry2, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc, registry: registry2, lobby: lobby2, now: now + 1000, log: quietLog });
  assert.deepEqual({ sessions: stats.sessions, rooms: stats.rooms, matches: stats.matches }, { sessions: 2, rooms: 1, matches: 0 });
  const resumed = registry2.byToken(a.token);
  assert.ok(resumed, 'the token resolves after the restart');
  assert.equal(resumed.playerId, a.playerId);
  assert.equal(resumed.roomCode, code);
  const room = lobby2.getRoom(code);
  assert.ok(room, 'the room is back');
  assert.equal(room.difficulty, 'HARD');
  assert.equal(room.hostId, a.playerId);
  assert.equal(room.seatOf(b.playerId).ready, true);
  assert.equal(room.seatOf(b.playerId).connected, false, 'everyone starts disconnected');
  // both humans are on a fresh lobby grace timer
  assert.equal(lobby2.graceTimers.size, 2);
});

test('sessions older than their reconnect window are dropped, with their seats', () => {
  const now = Date.now();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const doc = {
    v: PERSIST_VERSION,
    savedAt: now,
    sessions: [
      { playerId: 'p_live', token: 'aa', name: 'Live', connected: true, disconnectedAt: now - 60_000, roomCode: 'AAAA', resumeWindowMs: null },
      { playerId: 'p_dead', token: 'bb', name: 'Gone', connected: false, disconnectedAt: now - 11 * 60_000, roomCode: 'AAAA', resumeWindowMs: null },
      { playerId: 'p_solo', token: 'cc', name: 'Solo', connected: false, disconnectedAt: now - 11 * 60_000, roomCode: 'BBBB', resumeWindowMs: 24 * 3600_000 },
    ],
    rooms: [
      { code: 'AAAA', mode: 'coop', difficulty: 'NORMAL', hostId: 'p_live', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_live', name: 'Live', isBot: false, ready: false, left: false, connected: true },
          { seat: 1, playerId: 'p_dead', name: 'Gone', isBot: false, ready: false, left: false, connected: true }] },
      { code: 'BBBB', mode: 'solo', difficulty: 'NORMAL', hostId: 'p_solo', matchCount: 0,
        seats: [{ seat: 0, playerId: 'p_solo', name: 'Solo', isBot: false, ready: false, left: false, connected: true }] },
    ],
    matches: {},
  };
  const stats = restoreServer({ doc, registry, lobby, now, log: quietLog });
  assert.equal(stats.expired, 1, 'the 10-minute session is gone');
  assert.equal(stats.sessions, 2);
  assert.ok(registry.byToken('cc'), 'the 24 h solo window survives');
  assert.equal(registry.byToken('bb'), null);
  const coop = lobby.getRoom('AAAA');
  assert.ok(coop);
  assert.equal(coop.seats.filter(Boolean).length, 1, 'the expired seat is dropped');
  assert.equal(coop.hostId, 'p_live');
  assert.ok(lobby.getRoom('BBBB'), 'the solo room survives its longer window');
});

test('a document from another version is refused', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quietLog, MatchClass: StubMatch, getData: () => ({}) });
  const stats = restoreServer({ doc: { v: 99, sessions: [], rooms: [] }, registry, lobby, log: quietLog });
  assert.equal(stats.ok, false);
  assert.match(stats.reason, /version/);
  assert.equal(stats.rooms, 0);
});

test('sessionDoc measures a connected session from the write time', () => {
  const registry = new SessionRegistry();
  const s = registry.create('A');
  s.connected = true;
  s.disconnectedAt = null;
  const doc = sessionDoc(s, 1234);
  assert.equal(doc.disconnectedAt, 1234);
  s.connected = false;
  s.disconnectedAt = 999;
  assert.equal(sessionDoc(s, 1234).disconnectedAt, 999);
});

// ---------------------------------------------------------------------------------------------------
// live server: sessions and a room come back
// ---------------------------------------------------------------------------------------------------

test('a restart keeps players on their seats (tokens resolve, room state resumes)', async () => {
  const store = new MemoryStore();
  const srvA = await startServer({ port: 0, quiet: true, store, MatchClass: StubMatch, log: quietLog });
  const c1 = await player(srvA.port, 'Alice');
  const c2 = await player(srvA.port, 'Bob');
  const created = await c1.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  assert.equal(created.t, 'ok');
  const state = await c1.waitFor('room.state');
  const code = state.code;
  await c2.request({ t: 'room.join', code });
  await c1.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
  await c2.request({ t: 'room.ready', ready: true });
  const id1 = c1.id;
  const token1 = c1.token;
  const token2 = c2.token;
  await c1.close();
  await c2.close();
  await srvA.close();
  assert.ok(store.writes > 0, 'the shutdown flushed the state');
  assert.equal(store.doc.rooms.length, 1);

  const srvB = await startServer({ port: 0, quiet: true, store, MatchClass: StubMatch, log: quietLog });
  try {
    assert.equal(srvB.persister.matchDocs.size, 0);
    const back = await player(srvB.port, 'Alice', token1);
    assert.equal(back.id, id1, 'same player id after the restart');
    const resumed = await back.waitFor('room.state');
    assert.equal(resumed.code, code);
    assert.equal(resumed.hostId, id1);
    assert.equal(resumed.seats.filter(Boolean).length, 2);
    assert.equal(resumed.seats.find((s) => s.playerId === id1).connected, true);
    const other = await player(srvB.port, 'Bob', token2);
    await other.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
  } finally {
    await srvB.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// live server: a running match comes back
// ---------------------------------------------------------------------------------------------------

test('a running match resumes from its last checkpoint (round, board, phase)', async (t) => {
  const store = new MemoryStore();
  const servers = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch, log: quietLog });
    servers.push(srv);
    return srv;
  };
  t.after(async () => { for (const srv of servers) await srv.close().catch(() => {}); });

  const srvA = await boot();
  const c = await player(srvA.port, 'Solo');
  const token = c.token;
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const code = (await c.waitFor('room.state')).code;
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const match = srvA.lobby.getRoom(code).match;
  assert.ok(match && match.phase === PHASE.INFO_CHECK, `match started (${match && match.phase})`);

  // drive the virtual clock to a checkpointable PREP with a purchased operator in hand
  assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  until(match, () => match.phase === PHASE.BAND_DRAFT);
  assert.equal((await c.request({ t: 'g.band', bandId: match.gd.bandIds()[0] })).t, 'ok');
  until(match, () => match.phase === PHASE.PREP);
  const ps = match.players.get(c.id);
  const slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
  assert.equal((await c.request({ t: 'g.buy', slot })).t, 'ok');
  const bought = [...ps.hand].filter(Boolean).length;
  const funds = ps.funds;
  assert.ok(bought > 0, 'bought an operator');

  srvA.persister.checkpointMatches();
  assert.equal(srvA.persister.matchDocs.size, 1, 'checkpoint taken');
  await srvA.persister.flush('test');
  await c.close();
  await srvA.close();

  const srvB = await boot();
  const room2 = srvB.lobby.getRoom(code);
  assert.ok(room2, 'the room is back');
  assert.ok(room2.match, 'the match runs again');
  assert.equal(room2.match.phase, PHASE.PREP);
  assert.equal(room2.match.round, 1);
  assert.equal(room2.match.errorCount, 0);
  const ps2 = room2.match.players.get(c.id);
  assert.equal(ps2.funds, funds, 'economy restored');
  assert.equal([...ps2.hand].filter(Boolean).length, bought, 'hand restored');

  // the player resumes into the running match and gets its views
  const back = await player(srvB.port, 'Solo', token);
  assert.equal(back.id, c.id);
  const state = await back.waitFor('room.state');
  assert.equal(state.inMatch, true);
  const pub = await back.waitFor('m.public');
  assert.equal(pub.phase, PHASE.PREP);
  await back.waitFor('m.private');
  // and the restored match keeps playing: the prep ends into the round's battle
  assert.equal((await back.request({ t: 'g.ready', ready: true })).t, 'ok');
  until(room2.match, () => room2.match.phase !== PHASE.PREP, 2000);
  assert.notEqual(room2.match.phase, PHASE.PREP, 'the restored prep went to battle');
  assert.equal(room2.match.round, 1);
  assert.equal(room2.match.errorCount, 0, JSON.stringify(room2.match.errors.slice(0, 2)));
});

test('a checkpoint whose player lost their session is not resumed (room stays in the lobby)', async (t) => {
  const store = new MemoryStore();
  const servers = [];
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch, log: quietLog });
    servers.push(srv);
    return srv;
  };
  t.after(async () => { for (const srv of servers) await srv.close().catch(() => {}); });

  const srvA = await boot();
  const c = await player(srvA.port, 'Solo');
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const code = (await c.waitFor('room.state')).code;
  await c.request({ t: 'room.start' });
  const match = srvA.lobby.getRoom(code).match;
  await c.request({ t: 'g.infoReady' });
  until(match, () => match.phase === PHASE.BAND_DRAFT);
  await c.request({ t: 'g.band', bandId: match.gd.bandIds()[0] });
  until(match, () => match.phase === PHASE.PREP);
  assert.equal(match.phase, PHASE.PREP);
  srvA.persister.checkpointMatches();
  await srvA.persister.flush('test');
  await c.close();
  await srvA.close();

  // the player is gone for three days: the solo 24 h window is over
  const doc = JSON.parse(JSON.stringify(store.doc));
  const threeDays = 3 * 24 * 3600_000;
  // both fields matter: a session that was *connected* when the document was written is measured from the load, not
  // from the recorded disconnect time (server/persist.js), so a resurrected "connected" flag would keep it alive
  for (const s of doc.sessions) { s.connected = false; s.disconnectedAt = Date.now() - threeDays; }
  doc.rooms[0].seats.forEach((s) => { s.connected = false; });
  await store.save(doc);

  const srvB = await boot();
  // assert on primitives: an AssertionError carrying a whole Room (its Match, its pool, its timers) would be serialized
  // by the test runner and blow the heap up
  assert.equal(srvB.lobby.rooms.size, 0, 'no room without a session');
  assert.equal(srvB.registry.size, 0, 'no session either');
});
