import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { snapshotMatch, matchState as persistentState } from '../server/match/snapshot.js';
import { Persister, snapshotServer, restoreServer } from '../server/persist.js';
import { DATA, give } from './match/harness.js';
import { FakeBattle } from './match/fakeBattle.js';
import { PHASE } from '../shared/constants.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

class TestMatch extends Match {
  constructor(opts) {
    super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: true }),
      BattleClass: FakeBattle, botRehearsal: 0, clientCombat: false });
  }
}

function setup(t, registry = new SessionRegistry()) {
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn: (line) => warnings.push(line) };
  const lobby = new Lobby({ registry, MatchClass: TestMatch, getData: () => DATA, log });
  t.after(() => lobby.shutdown());
  return { registry, lobby, warnings, log };
}

function running(t, phase = PHASE.PREP) {
  const env = setup(t);
  const a = env.registry.create('A'), b = env.registry.create('B');
  assert.deepEqual(env.lobby.startQueuedMatch({ mode: 'coop', difficulty: 'NORMAL' },
    [a, b].map((s, seat) => ({ seat, playerId: s.playerId, name: s.name, isBot: false, connected: true })), []), { ok: true });
  const ctx = a.activeMatchCtx;
  assert.ok(ctx.match.sched.runUntil(() => ctx.match.phase === phase, { maxSteps: 20_000 }));
  return { ...env, a, b, ctx, key: `queue:${ctx.match.roomCode}` };
}

function document(env) {
  return snapshotServer({ ...env, matchDocs: new Map([[env.key, snapshotMatch(env.ctx.match)]]) });
}

function restore(t, doc) {
  const env = setup(t);
  const stats = restoreServer({ doc, ...env });
  return { ...env, stats, ctx: [...env.lobby.activeQueueMatches][0] };
}

function runningRoom(t, { queue = false, guestRoom = false } = {}) {
  const env = setup(t);
  const a = env.registry.create('Host'), b = env.registry.create('Guest');
  assert.deepEqual(env.lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = env.lobby.getRoom(a.roomCode);
  if (queue) {
    if (guestRoom) assert.deepEqual(env.lobby.create(b, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
    assert.deepEqual(env.lobby.startQueuedMatch({ room, mode: room.mode, difficulty: room.difficulty },
      [a, b].map((s, seat) => ({ seat, playerId: s.playerId, name: s.name, isBot: false, connected: true })), []), { ok: true });
  } else {
    assert.deepEqual(env.lobby.join(b, { code: room.code }), { ok: true });
    assert.deepEqual(env.lobby.startMatch(room), { ok: true });
  }
  assert.ok(room.match.sched.runUntil(() => room.match.phase === PHASE.PREP, { maxSteps: 20_000 }));
  return { ...env, a, b, room, ctx: room.matchCtx, key: room.code };
}

test('a room queue restores public teammates who have no seat in its owning room (legacy document)', (t) => {
  const env = runningRoom(t, { queue: true });
  const doc = document(env);
  delete doc.rooms[0].queueMatch;
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  const room = back.lobby.getRoom(env.key);
  assert.ok(room.matchCtx.queue);
  assert.equal(back.registry.byId(env.a.playerId).activeMatchCtx, room.matchCtx);
  const guest = back.registry.byId(env.b.playerId);
  assert.equal(guest.roomCode, null);
  assert.equal(guest.activeMatchCtx, room.matchCtx);
  assert.deepEqual(back.lobby.routeGame(guest, { t: 'g.autoplay', on: true }), { ok: true });
  assert.equal(room.match.players.get(guest.playerId).autoplay, true);
});

test('a room departure after its safe checkpoint is reapplied from the current room seat', (t) => {
  const env = runningRoom(t);
  const doc = document(env);
  env.ctx.match.phase = PHASE.COMBAT;
  env.lobby.removeMember(env.room, env.b.playerId);
  const latest = snapshotServer(env);
  latest.matches = doc.matches;
  delete latest.matchDepartures;
  const back = restore(t, latest);
  assert.equal(back.stats.matches, 1);
  const ps = back.lobby.getRoom(env.key).match.players.get(env.b.playerId);
  assert.equal(ps.left, true);
  assert.equal(ps.alive, false);
  assert.equal(ps.lp, 0);
});

test('a matched guest keeps their own lobby room and reconnects to the owning match', (t) => {
  const env = runningRoom(t, { queue: true, guestRoom: true });
  const guestRoom = env.b.roomCode;
  const back = restore(t, document(env));
  assert.equal(back.stats.matches, 1);
  const guest = back.registry.byId(env.b.playerId);
  const ctx = back.lobby.getRoom(env.key).matchCtx;
  assert.equal(guest.activeMatchCtx, ctx);
  assert.equal(guest.roomCode, guestRoom);
  const calls = [];
  ctx.match.onReconnect = (id) => calls.push(id);
  guest.connected = true;
  back.lobby.runResync(guest);
  assert.deepEqual(calls, [guest.playerId]);
  assert.deepEqual(back.lobby.routeGame(guest, { t: 'g.leave' }), { ok: true });
  assert.equal(ctx.match.players.get(guest.playerId).left, true);
  assert.equal(guest.activeMatchCtx, null);
  assert.equal(guest.roomCode, guestRoom);
});

test('a departed human with no session does not prevent standalone teammates from resuming', (t) => {
  const env = running(t);
  env.lobby.leaveQueuedMatchPlayer(env.ctx, env.b.playerId);
  env.registry.remove(env.b);
  const back = restore(t, document(env));
  assert.equal(back.stats.matches, 1);
  assert.equal(back.registry.byId(env.a.playerId).activeMatchCtx, back.ctx);
  assert.equal(back.ctx.match.players.get(env.b.playerId).left, true);
  assert.equal(back.ctx.members.find((p) => p.playerId === env.b.playerId).left, true);
});

test('a departed human is not rebound or removed from their new room after restore', (t) => {
  const env = running(t);
  env.lobby.leaveQueuedMatchPlayer(env.ctx, env.b.playerId);
  assert.deepEqual(env.lobby.create(env.b, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  const code = env.b.roomCode;
  const back = restore(t, document(env));
  assert.equal(back.stats.matches, 1);
  const departed = back.registry.byId(env.b.playerId);
  assert.equal(departed.activeMatchCtx == null, true);
  assert.equal(back.lobby.activeMatchOf(departed), null);
  assert.equal(departed.roomCode, code);
  back.lobby.onQueuedMatchEnd(back.ctx, {});
  assert.equal(departed.roomCode, code, 'ending the old match must not clear a new room');
});

test('departures after the last safe checkpoint survive save, restart, and another save', async (t) => {
  const env = running(t);
  const persister = new Persister({ ...env, store: {} });
  t.after(() => persister.encoder.close());
  await persister.checkpointMatches();
  const oldFunds = env.ctx.match.players.get(env.a.playerId).funds;
  env.ctx.match.phase = PHASE.COMBAT;
  env.ctx.match.players.get(env.a.playerId).funds++;
  env.lobby.leaveQueuedMatchPlayer(env.ctx, env.b.playerId);
  env.registry.remove(env.b);
  const doc = await persister.document();
  assert.equal(doc.matches[env.key].players.find((p) => p.playerId === env.b.playerId).left, false,
    'the safe checkpoint itself stays unchanged');
  assert.deepEqual(doc.matchDepartures[env.key], [env.b.playerId]);
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  const ps = back.ctx.match.players.get(env.b.playerId);
  assert.equal(ps.left, true);
  assert.equal(ps.alive, false);
  assert.equal(ps.lp, 0);
  assert.equal(back.ctx.match.players.get(env.a.playerId).funds, oldFunds);
  const writer = new Persister({ ...back, store: {} });
  t.after(() => writer.encoder.close());
  await writer.seed(doc);
  back.ctx.match.phase = PHASE.COMBAT;
  const again = restore(t, await writer.document());
  assert.equal(again.stats.matches, 1);
  assert.equal(again.ctx.match.players.get(env.b.playerId).left, true);
});

test('a missing active human leaves the restored match while available teammates keep playing', (t) => {
  const env = running(t);
  env.registry.remove(env.b);
  const back = restore(t, document(env));
  assert.equal(back.stats.matches, 1);
  assert.equal(back.ctx.match.players.get(env.b.playerId).left, true);
  assert.equal(back.ctx.match.players.get(env.b.playerId).alive, false);
  assert.equal(back.registry.byId(env.a.playerId).activeMatchCtx, back.ctx);
  assert.ok(back.warnings.some((line) => line.includes(env.b.playerId) && line.includes('session')));
});

test('a checkpoint with no remaining human is retained without starting an unattended game', (t) => {
  const env = running(t);
  const doc = document(env);
  for (const p of doc.matches[env.key].players) p.left = true;
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 0);
  assert.equal(back.lobby.activeQueueMatches.size, 0);
  assert.equal(back.stats.deferredMatches, 1);
  assert.deepEqual(back.lobby.recoveryDocs.get(env.key).checkpoint, doc.matches[env.key]);
});

test('registry capacity cannot evict a disconnected human from a running standalone match', () => {
  const registry = new SessionRegistry({ maxSessions: 1 });
  const human = registry.create('Active');
  human.activeMatchCtx = { match: {}, live: true, ended: false, disposed: false };
  assert.equal(registry.create('New'), null);
  assert.equal(registry.byId(human.playerId), human);
  human.activeMatchCtx.disposed = true;
  assert.ok(registry.create('New'), 'a disposed match does not keep an idle session forever');
});

test('two room parties resume one shared match and every token receives its game state over WebSocket', async (t) => {
  const store = {
    doc: null,
    async load() { return this.doc ? structuredClone(this.doc) : null; },
    async save(doc) { this.doc = structuredClone(doc); return true; },
    async close() {},
  };
  const servers = [], clients = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
  });
  const boot = async () => {
    const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch,
      log: { info() {}, debug() {}, warn() {}, error() {} } });
    servers.push(srv);
    return srv;
  };
  const connect = async (srv, name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const welcome = await c.hello(name, token);
    c.id = welcome.playerId;
    c.token = welcome.token;
    return c;
  };
  const first = await boot();
  const cs = [];
  for (const name of ['Host A', 'Guest A', 'Host B', 'Guest B']) cs.push(await connect(first, name));
  const codes = [];
  for (const i of [0, 2]) {
    assert.equal((await cs[i].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const state = await cs[i].waitFor('room.state');
    codes.push(state.code);
    assert.equal((await cs[i + 1].request({ t: 'room.join', code: state.code })).t, 'ok');
    assert.equal((await cs[i].request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL', fillBots: true })).t, 'ok');
  }
  for (const c of cs) await c.waitFor('m.public', (m) => m.phase === PHASE.INFO_CHECK);
  for (const c of cs) await c.close();
  await first.close();
  const second = await boot();
  assert.equal(second.lobby.stats().matches, 1);
  const ctx = second.lobby.getRoom(codes[0]).matchCtx;
  for (const c of cs) {
    const back = await connect(second, c.id, c.token);
    const pub = await back.waitFor('m.public', (m) => m.phase === PHASE.INFO_CHECK);
    assert.deepEqual(pub.players.map((p) => p.playerId).sort(), cs.map((p) => p.id).sort());
    assert.equal(second.registry.byId(back.id).activeMatchCtx, ctx);
    assert.equal((await back.request({ t: 'g.autoplay', on: true })).t, 'ok');
  }
  assert.equal(second.registry.byId(cs[2].id).roomCode, codes[1]);
  const expired = second.registry.byId(cs[3].id);
  second.registry.remove(expired);
  second.lobby.onExpire(expired);
  assert.equal(ctx.match.players.get(expired.playerId).left, true);
  assert.equal(ctx.match.disposed, false);
});

test('an expired teammate does not discard the remaining human checkpoint', (t) => {
  const env = running(t);
  const doc = document(env);
  const lost = doc.sessions.find((s) => s.playerId === env.b.playerId);
  lost.connected = false;
  lost.disconnectedAt = Date.now() - 24 * 3600_000;
  const back = restore(t, doc);
  assert.equal(back.stats.expired, 1);
  assert.equal(back.stats.matches, 1);
  assert.equal(back.ctx.match.players.get(env.b.playerId).left, true);
});

test('a missing room record is reconstructed from a valid checkpoint and its tokens', (t) => {
  const env = runningRoom(t);
  const doc = document(env);
  doc.rooms = [];
  const back = restore(t, doc);
  assert.equal(back.stats.rooms, 1);
  assert.equal(back.stats.matches, 1);
  const room = back.lobby.getRoom(env.key);
  assert.ok(room.match);
  assert.equal(room.match.round, env.ctx.match.round);
  assert.equal(back.registry.byToken(env.a.token).playerId, env.a.playerId);
});

test('public teammates resume even when the owning room loses its last original human session', (t) => {
  const env = runningRoom(t, { queue: true });
  env.registry.remove(env.a);
  const back = restore(t, document(env));
  assert.equal(back.stats.matches, 1);
  const room = back.lobby.getRoom(env.key);
  assert.equal(room.match.players.get(env.a.playerId).left, true);
  assert.equal(back.registry.byId(env.b.playerId).activeMatchCtx, room.matchCtx);
});

test('invalid and duplicate seat records are isolated from usable player state', (t) => {
  const env = running(t);
  const doc = document(env);
  const cp = doc.matches[env.key];
  cp.players.push(null, { ...cp.players[0] });
  for (const p of cp.players) if (p) p.seat = 99;
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  assert.deepEqual(back.ctx.match.order.map((p) => p.seat), [0, 1]);
  assert.equal(back.ctx.match.players.size, 2);
  assert.equal(back.ctx.match.players.get(env.a.playerId).funds, env.ctx.match.players.get(env.a.playerId).funds);
});

test('active tokens survive a reduced session-capacity setting', (t) => {
  const env = running(t);
  const back = setup(t, new SessionRegistry({ maxSessions: 1 }));
  const stats = restoreServer({ doc: document(env), ...back });
  assert.equal(stats.matches, 1);
  assert.equal(back.registry.size, 2);
  assert.equal(back.registry.byToken(env.a.token).playerId, env.a.playerId);
  assert.equal(back.registry.create('extra'), null, 'normal admission keeps the configured capacity');
});

for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, 'unknown']) {
  test(`unsupported checkpoint phase ${phase} recovers prep without repeating income`, (t) => {
    const env = running(t);
    const doc = document(env);
    doc.matches[env.key].phase = phase;
    const back = restore(t, doc);
    assert.equal(back.stats.matches, 1);
    assert.equal(back.ctx.match.phase, PHASE.PREP);
    assert.equal(back.ctx.match.round, env.ctx.match.round);
    assert.equal(back.ctx.match.players.get(env.a.playerId).funds, env.ctx.match.players.get(env.a.playerId).funds);
    assert.ok(back.ctx.match.sched.runUntil(() => back.ctx.match.phase === PHASE.COMBAT, { maxSteps: 20_000 }));
    assert.equal(back.ctx.match.errorCount, 0);
  });
}

test('a damaged strategy draft is reconstructed from player selections and resumes a valid turn', (t) => {
  const env = running(t, PHASE.BAND_DRAFT);
  const doc = document(env);
  doc.matches[env.key].draft = { order: null, picks: null };
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  assert.equal(back.ctx.match.phase, PHASE.BAND_DRAFT);
  assert.ok(back.ctx.match.players.has(back.ctx.match.draftTurn()));
  assert.ok(back.ctx.match.sched.runUntil(() => back.ctx.match.phase === PHASE.PREP, { maxSteps: 20_000 }));
  assert.equal(back.ctx.match.errorCount, 0);
});

test('a damaged special draft resumes prep while preserving saved economy and a playable battle', (t) => {
  const env = running(t);
  const doc = document(env);
  doc.matches[env.key].phase = PHASE.SP_DRAFT;
  doc.matches[env.key].sp = { order: [], cards: null };
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  assert.equal(back.ctx.match.phase, PHASE.PREP);
  assert.equal(back.ctx.match.players.get(env.a.playerId).funds, env.ctx.match.players.get(env.a.playerId).funds);
});

test('missing or corrupt optional fields preserve defaults and do not discard valid economy', (t) => {
  const env = running(t);
  const doc = document(env);
  const cp = doc.matches[env.key];
  delete cp.clientCombat;
  delete cp.timerScale;
  cp.simErrorLog = { $spMap: 'broken' };
  const ps = cp.players[0];
  ps.hand = null;
  ps.layers = [];
  ps.effects = null;
  delete ps.shop.upgradePrice;
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  const match = back.ctx.match;
  assert.equal(match.timerScale, 1);
  assert.ok(match.simErrorLog instanceof Map);
  assert.equal(match.players.get(ps.playerId).funds, ps.funds);
  assert.ok(Array.isArray(match.players.get(ps.playerId).hand));
  assert.equal(typeof match.players.get(ps.playerId).shop.upgradePrice, 'number');
  assert.ok(match.sched.runUntil(() => match.phase === PHASE.COMBAT, { maxSteps: 20_000 }));
  assert.equal(match.errorCount, 0);
});

test('compatible fields from a different document and checkpoint version still resume', (t) => {
  const env = running(t);
  const doc = document(env);
  doc.v = 0;
  doc.matches[env.key].v = 0;
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  assert.equal(back.ctx.match.round, env.ctx.match.round);
});

test('one throwing restore does not stop a separate healthy match or delete its failed checkpoint', (t) => {
  const a = running(t), b = running(t);
  const adoc = document(a), bdoc = document(b);
  const doc = { ...adoc, sessions: [...adoc.sessions, ...bdoc.sessions], matches: { ...adoc.matches, ...bdoc.matches } };
  const back = setup(t);
  const restoreQueue = back.lobby.restoreQueuedMatch.bind(back.lobby);
  back.lobby.restoreQueuedMatch = (cp, opts) => {
    if (cp.roomCode === a.ctx.match.roomCode) throw new Error('one damaged game');
    return restoreQueue(cp, opts);
  };
  const stats = restoreServer({ doc, ...back });
  assert.equal(stats.matches, 1);
  assert.equal(stats.deferredMatches, 1);
  assert.deepEqual(back.lobby.recoveryDocs.get(a.key).checkpoint, adoc.matches[a.key]);
  assert.ok(back.registry.byId(b.a.playerId).activeMatchCtx);
});

test('unavailable game data retains checkpoints across save and another restart until it is available', async (t) => {
  const env = running(t);
  const doc = document(env);
  const back = setup(t);
  back.lobby.getData = () => ({});
  const stats = restoreServer({ doc, ...back });
  assert.equal(stats.matches, 0);
  assert.equal(stats.deferredMatches, 1);
  const writer = new Persister({ ...back, store: {} });
  t.after(() => writer.encoder.close());
  await writer.seed(doc);
  const saved = await writer.document();
  assert.deepEqual(saved.recovery[env.key].checkpoint, doc.matches[env.key]);
  assert.ok(saved.recovery[env.key].sessions.some((s) => s.token === env.a.token));
  const again = restore(t, saved);
  assert.equal(again.stats.matches, 1);
  assert.equal(again.registry.byToken(env.a.token).activeMatchCtx, again.ctx);
  assert.equal(again.lobby.recoveryDocs.size, 0);
});

test('a worker seed failure preserves the loaded combat checkpoint for a later save', async (t) => {
  const env = running(t);
  const doc = document(env);
  const back = restore(t, doc);
  const writer = new Persister({ ...back, store: {} });
  t.after(() => writer.encoder.close());
  const request = writer.encoder.request.bind(writer.encoder);
  writer.encoder.request = (type, payload) => type === 'seed' ? Promise.reject(new Error('seed interrupted')) : request(type, payload);
  assert.equal(await writer.seed(doc), false);
  back.ctx.match.phase = PHASE.COMBAT;
  const saved = await writer.document();
  assert.deepEqual(saved.matches[env.key], doc.matches[env.key]);
});

test('healthy best-effort recovery preserves inventory, economy, pools, RNG and all persistent fields', (t) => {
  const env = running(t);
  give(env.ctx.match, env.ctx.match.players.get(env.a.playerId), [...env.ctx.match.pool.entries.keys()][0]);
  const before = persistentState(env.ctx.match);
  const back = restore(t, document(env));
  const after = persistentState(back.ctx.match);
  after.match._battleSeq = before.match._battleSeq;
  for (const [id, ps] of Object.entries(after.players)) ps.connected = before.players[id].connected;
  assert.deepEqual(after, before);
});

test('missing humans return their held copies while surviving players keep their inventories', (t) => {
  const env = running(t);
  const id = [...env.ctx.match.pool.entries.keys()][0];
  const owned = give(env.ctx.match, env.ctx.match.players.get(env.a.playerId), id);
  const lost = give(env.ctx.match, env.ctx.match.players.get(env.b.playerId), id);
  const left = env.ctx.match.pool.entries.get(id).left;
  env.registry.remove(env.b);
  const back = restore(t, document(env));
  assert.equal(back.ctx.match.pool.entries.get(id).left, left + lost.poolCopies);
  assert.ok(back.ctx.match.players.get(env.a.playerId).find(owned.uid));
  assert.ok(back.ctx.match.players.get(env.b.playerId).hand.every((p) => p == null));
});

test('broken inventory entries do not discard a valid operator or prevent the next battle', (t) => {
  const env = running(t);
  const held = give(env.ctx.match, env.ctx.match.players.get(env.a.playerId), [...env.ctx.match.pool.entries.keys()][0]);
  const doc = document(env);
  const ps = doc.matches[env.key].players[0];
  ps.hand[1] = 'not a piece';
  ps.board.$spMap.push(['9,2', null]);
  ps.shop.slots.push('broken slot');
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  assert.ok(back.ctx.match.players.get(env.a.playerId).find(held.uid));
  assert.ok(back.ctx.match.sched.runUntil(() => back.ctx.match.phase === PHASE.COMBAT, { maxSteps: 20_000 }));
  assert.equal(back.ctx.match.errorCount, 0);
});

test('continuous restarts before a fresh safe checkpoint cannot reuse a battle sequence', async (t) => {
  const env = running(t);
  const doc = document(env);
  let back = restore(t, doc);
  const firstSeq = back.ctx.match._battleSeq;
  const writer = new Persister({ ...back, store: {} });
  t.after(() => writer.encoder.close());
  await writer.seed(doc);
  back.ctx.match.phase = PHASE.COMBAT;
  back.ctx.match._battleSeq++;
  const saved = await writer.document();
  assert.equal(saved.matches[env.key]._battleSeq, doc.matches[env.key]._battleSeq);
  back = restore(t, saved);
  assert.ok(back.ctx.match._battleSeq > firstSeq);
});

test('a partial recovery that eliminates the last fighter keeps settlement frames for the remaining token', (t) => {
  const env = running(t);
  const doc = document(env);
  const cp = doc.matches[env.key];
  cp.players.find((p) => p.playerId === env.a.playerId).alive = false;
  cp.players.find((p) => p.playerId === env.a.playerId).lp = 0;
  doc.sessions = doc.sessions.filter((s) => s.playerId !== env.b.playerId);
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 1);
  const session = back.registry.byToken(env.a.token);
  assert.ok(session.pendingResult.some((frame) => JSON.parse(frame).t === 'm.result'));
  const again = restore(t, snapshotServer(back));
  assert.deepEqual(again.registry.byToken(env.a.token).pendingResult, session.pendingResult);
});

test('startup Redis read failure protects stored state and old tokens until retry succeeds', async (t) => {
  const env = running(t);
  const saved = document(env);
  const store = {
    available: false, loadState: 'unavailable', writes: 0, doc: saved,
    async load() { this.loadState = this.available ? 'loaded' : 'unavailable'; return this.available ? structuredClone(this.doc) : null; },
    async save(doc) { this.writes++; this.doc = structuredClone(doc); return true; },
    async close() {},
  };
  const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch,
    log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => srv.close());
  assert.equal(await srv.persister.flush('unavailable'), false);
  assert.equal(store.writes, 0);
  const pending = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  pending.send({ t: 'hello', name: 'A', version: 1, token: env.a.token });
  assert.equal((await pending.closed).code, 1013);
  assert.equal(pending.log.some((m) => m.t === 'welcome'), false);
  store.available = true;
  assert.equal(await srv.persister.flush('retry'), true);
  assert.equal(srv.registry.recoveryPending, false);
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => client.close());
  const welcome = await client.hello('A', env.a.token);
  assert.equal(welcome.playerId, env.a.playerId);
  assert.equal(welcome.token, env.a.token);
  await client.waitFor('m.public');
});

test('an unreadable startup document is not overwritten during a shutdown save', async (t) => {
  const original = { v: 99, futureSchema: { value: 'preserve' } };
  const store = { doc: original, writes: 0,
    async load() { return structuredClone(this.doc); },
    async save(doc) { this.writes++; this.doc = structuredClone(doc); return true; },
    async close() {} };
  const srv = await startServer({ port: 0, quiet: true, store, MatchClass: TestMatch,
    log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => srv.close());
  assert.equal(await srv.persister.flush(), false);
  await srv.close();
  assert.equal(store.writes, 0);
  assert.deepEqual(store.doc, original);
});

test('explicit session ownership prevents double binding without abandoning either group of teammates', (t) => {
  const a = running(t), b = running(t);
  const adoc = document(a), bdoc = document(b);
  bdoc.matches[b.key].players[0].playerId = a.a.playerId;
  const doc = { ...adoc, sessions: [...adoc.sessions, bdoc.sessions.find((s) => s.playerId === b.b.playerId)],
    matches: { ...adoc.matches, ...bdoc.matches } };
  const back = restore(t, doc);
  assert.equal(back.stats.matches, 2);
  const owner = back.registry.byId(a.a.playerId).activeMatchCtx;
  const other = back.registry.byId(b.b.playerId).activeMatchCtx;
  assert.equal(owner.match.roomCode, a.ctx.match.roomCode);
  assert.equal(other.match.players.get(a.a.playerId).left, true);
  assert.notEqual(owner, other);
});

test('starting a new game in a deferred room archives its old checkpoint without resurrecting it later', async (t) => {
  const env = runningRoom(t);
  const original = document(env);
  const back = setup(t);
  back.lobby.getData = () => ({});
  assert.equal(restoreServer({ doc: original, ...back }).deferredMatches, 1);
  back.lobby.getData = () => DATA;
  assert.deepEqual(back.lobby.startMatch(back.lobby.getRoom(env.key)), { ok: true });
  const writer = new Persister({ ...back, store: {} });
  t.after(() => writer.encoder.close());
  await writer.seed(original);
  const saved = await writer.document();
  const archive = Object.values(saved.recovery).find((entry) => entry.superseded);
  assert.deepEqual(archive.checkpoint, original.matches[env.key]);
  assert.equal(saved.matches[env.key].phase, PHASE.INFO_CHECK);
  const again = restore(t, saved);
  assert.equal(again.stats.matches, 1);
  assert.equal(again.lobby.getRoom(env.key).match.phase, PHASE.INFO_CHECK);
  assert.ok([...again.lobby.recoveryDocs.values()].some((entry) => entry.superseded));
});

test('a fast-started match entering combat before a periodic save keeps its initial checkpoint', async (t) => {
  const env = setup(t);
  let saved;
  const writer = new Persister({ ...env, store: { async save(doc) { saved = doc; return true; } } }).start();
  t.after(() => writer.shutdown());
  const a = env.registry.create('A'), b = env.registry.create('B');
  assert.deepEqual(env.lobby.startQueuedMatch({ mode: 'coop', difficulty: 'NORMAL' },
    [a, b].map((s, seat) => ({ seat, playerId: s.playerId, name: s.name, isBot: false, connected: true })), []), { ok: true });
  const key = `queue:${a.activeMatchCtx.match.roomCode}`;
  a.activeMatchCtx.match.phase = PHASE.COMBAT;
  await writer.flush('test');
  assert.equal(saved.matches[key].phase, PHASE.INFO_CHECK);
  assert.equal(restore(t, saved).stats.matches, 1);
});

test('a new match queues another immediate save when a state write is already in flight', { timeout: 5000 }, async (t) => {
  const env = setup(t);
  let release, entered, secondSaved;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const second = new Promise((resolve) => { secondSaved = resolve; });
  let writes = 0, saved;
  const writer = new Persister({ ...env, store: { async save(doc) {
    writes++; saved = doc;
    if (writes === 1) { entered(); await gate; }
    else secondSaved();
    return true;
  } } }).start();
  t.after(() => writer.shutdown());
  const firstWrite = writer.flush('test');
  await started;
  const capture = writer.checkpoint.bind(writer);
  const captures = [];
  writer.checkpoint = (item) => { const promise = capture(item); captures.push(promise); return promise; };
  const a = env.registry.create('A'), b = env.registry.create('B');
  env.lobby.startQueuedMatch({ mode: 'coop', difficulty: 'NORMAL' },
    [a, b].map((s, seat) => ({ seat, playerId: s.playerId, name: s.name, isBot: false, connected: true })), []);
  const key = `queue:${a.activeMatchCtx.match.roomCode}`;
  a.activeMatchCtx.match.phase = PHASE.COMBAT;
  await captures[0];
  release();
  await firstWrite;
  await second;
  assert.equal(saved.matches[key].phase, PHASE.INFO_CHECK);
});

test('shutdown rejects state changes while its final state write is in flight', { timeout: 5000 }, async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const store = { async load() { return null; }, async save() { entered(); await gate; return true; }, async close() {} };
  const srv = await startServer({ port: 0, quiet: true, store,
    log: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(async () => { release(); await srv.close(); });
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => client.close());
  const welcome = await client.hello('Host');
  await client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const code = srv.registry.byId(welcome.playerId).roomCode;
  const closing = srv.close();
  await started;
  const reply = await client.request({ t: 'room.setDifficulty', difficulty: 'HARD' });
  assert.equal(reply.t, 'error');
  assert.equal(srv.lobby.getRoom(code).difficulty, 'NORMAL');
  release();
  await closing;
});
