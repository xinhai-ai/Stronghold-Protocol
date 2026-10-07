import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Lobby } from '../server/lobby.js';
import { TestClient } from './helpers/wsClient.js';

const clients = [];
let srv;

async function player(name) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  const w = await c.hello(name);
  c.id = w.playerId;
  clients.push(c);
  return c;
}

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  await srv?.close();
});

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, matchmakingWaitMs: 1000, matchmakingTickMs: 10 });
});

test('public and room matchmaking retain operator ownership and self-selected picks', async () => {
  const c = await player('QLoadout');
  const session = srv.registry.byId(c.id);
  session.notOwned = ['chess_char_4_22_a'];
  session.diy = { chess_char_5_diy1_a: { charId: 'char_112_siege', skillIndex: 2 } };
  for (const inRoom of [false, true]) {
    if (inRoom) {
      assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'ABYSS' })).t, 'ok');
      await c.waitFor('room.state', (s) => s.code);
    }
    assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'ABYSS', fillBots: false })).t, 'ok');
    const entry = srv.lobby.queueByPlayer.get(c.id);
    assert.deepEqual(entry.players[0].notOwned, session.notOwned);
    assert.deepEqual(entry.players[0].diy, session.diy);
    assert.equal((await c.request({ t: 'match.leave' })).t, 'ok');
  }
  assert.equal((await c.request({ t: 'room.leave' })).t, 'ok');
});

test('four alliance queue entries start one four-seat preparation match immediately', async () => {
  const cs = await Promise.all(['A', 'B', 'C', 'D'].map(player));
  for (const c of cs) {
    const reply = await c.request({ t: 'match.join', mode: 'coop', difficulty: 'FUNNY', fillBots: true });
    assert.equal(reply.t, 'ok');
    if (c === cs[0] && cs.indexOf(c) === 0) {
      const queued = await c.waitFor('match.queue', (m) => m.status === 'queued');
      assert.equal(queued.count, 1);
    }
    if (c === cs[1]) {
      const updated = await cs[0].waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
      assert.equal(updated.count, 2);
    }
  }
  for (const c of cs) {
    const pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    assert.equal(pub.players.length, 4);
    assert.equal(pub.players.filter((p) => p.isBot).length, 0);
  }
  assert.equal((await cs[0].request({ t: 'g.autoplay', on: true })).t, 'ok', 'standalone queue match accepts in-match intents');
  assert.equal(srv.lobby.stats().rooms, 0);
});

test('public teammates start immediately behind a private room ticket over WebSocket', async () => {
  const host = await player('Private head');
  const cs = await Promise.all(['Public A', 'Public B', 'Public C', 'Public D'].map(player));
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  await host.waitFor('room.state', (s) => s.code);
  assert.equal((await host.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL', fillBots: false })).t, 'ok');
  const original = await host.waitFor('match.queue', (m) => m.status === 'queued');
  for (const [i, c] of cs.entries()) {
    assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL', fillBots: true })).t, 'ok');
    const queued = await c.waitFor('match.queue', (m) => m.status === 'queued');
    assert.equal(queued.count, i + 1, 'private room is excluded from public group counts');
  }
  for (const c of cs) {
    await c.waitFor('match.queue', (m) => m.status === 'matched');
    const pub = await c.waitFor('m.public');
    assert.deepEqual(pub.players.map((p) => p.playerId).sort(), cs.map((c) => c.id).sort());
  }
  assert.equal((await host.request({ t: 'match.leave' })).t, 'ok');
  await host.waitFor('match.queue', (m) => m.status === 'cancelled');
  const updates = host.log.filter((m) => m.t === 'match.queue' && m.status === 'queued');
  assert.ok(updates.every((m) => m.count === 1 && m.deadlineAt === original.deadlineAt));
  assert.ok(!host.log.some((m) => m.t === 'm.public'), 'private head keeps waiting while public match starts');
});

test('room matchmaking fills AI after the deadline and returns to that room after the result', async () => {
  const c = await player('Room host');
  const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
  assert.equal(created.t, 'ok');
  const room = await c.waitFor('room.state', (s) => s.code);
  const queued = await c.request({ t: 'match.join', mode: 'coop', difficulty: 'FUNNY', fillBots: false });
  assert.equal(queued.t, 'ok');
  const q = await c.waitFor('match.queue', (m) => m.status === 'queued');
  assert.equal(q.fillBots, false);
  const matching = await c.waitFor('room.state', (s) => s.matching?.queueId === q.queueId);
  assert.equal(matching.inMatch, false);
  const pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK', 2500);
  assert.equal(pub.players.length, 4);
  assert.equal(pub.players.filter((p) => p.isBot).length, 3);
  await c.request({ t: 'g.infoReady' });
  await c.waitFor('m.result');
  const back = await c.waitFor('room.state', (s) => s.code === room.code && !s.inMatch);
  assert.equal(back.code, room.code);
  assert.ok(back.seats.some((s) => s?.playerId === c.id));
});

function manualQueue(t) {
  let now = 1000;
  const sessions = new Map();
  const lobby = new Lobby({ registry: { byId: (id) => sessions.get(id) }, now: () => now,
    options: { matchmakingWaitMs: 60_000 } });
  clearInterval(lobby.matchQueueTimer);
  lobby.matchQueueTimer = null;
  t.after(() => lobby.shutdown());
  const states = [], launched = [];
  lobby.broadcastState = (room) => states.push({ code: room.code, ...room.matching });
  lobby.startQueuedMatch = (owner, players) => launched.push(players);
  let seq = 0;
  return {
    lobby, states, launched,
    at(time) { now = time; },
    queueState(entry) { return sessions.get(entry.players[0].playerId).messages.at(-1); },
    join({ count = 1, difficulty = 'NORMAL', fillBots = true, room = null } = {}) {
      const entry = lobby.makeQueueEntry({ mode: 'coop', difficulty, fillBots, room,
        players: Array.from({ length: count }, () => {
          const playerId = `queue-test-${++seq}`;
          const messages = [];
          sessions.set(playerId, { playerId, connected: true, messages,
            ws: { readyState: 1, bufferedAmount: 0, send: (data) => messages.push(JSON.parse(data)) } });
          return { playerId, isBot: false };
        }) });
      lobby.enqueueMatchEntry(entry);
      return entry;
    },
  };
}

for (const scenario of [
  { name: 'eight humans behind a private ticket', sizes: [1, 1, 1, 1, 1, 1, 1, 1],
    privateHead: true, counts: [1, 4, 4, 4, 4, 3, 3, 3], matches: 1, remaining: [0, 5, 6, 7] },
  { name: 'thirteen humans in parties that cannot fit the head', sizes: [3, 2, 2, 2, 2, 2],
    privateHead: false, counts: [3, 4, 4, 4, 4, 2], matches: 2, remaining: [0, 5] },
]) {
  test(`queue counts and immediate launches use actual groups: ${scenario.name}`, (t) => {
    const q = manualQueue(t);
    const entries = scenario.sizes.map((count, i) => q.join({ count, fillBots: i !== 0 || !scenario.privateHead }));
    const deadlines = entries.map((entry) => entry.deadlineAt);
    assert.deepEqual(entries.map((entry) => q.queueState(entry).count), scenario.counts);
    assert.ok(entries.every((entry) => q.queueState(entry).capacity === 4));
    const otherDifficulty = q.join({ difficulty: 'HARD' });
    assert.equal(q.queueState(otherDifficulty).count, 1);

    q.lobby.processMatchQueues();
    assert.equal(q.launched.length, scenario.matches, 'later full groups start before the head deadline');
    assert.ok(q.launched.every((players) => players.length === 4 && players.every((p) => !p.isBot)));
    const remaining = scenario.remaining.map((i) => entries[i]);
    assert.deepEqual(q.lobby.matchQueues.get('coop:NORMAL'), remaining);
    assert.deepEqual(entries.map((entry) => entry.deadlineAt), deadlines, 'launches do not reset waits');
    for (const entry of remaining) {
      assert.equal(q.queueState(entry).count, scenario.counts[entries.indexOf(entry)]);
      for (const p of entry.players) assert.equal(q.lobby.queueByPlayer.get(p.playerId), entry);
    }
    const launchedIds = q.launched.flat().map((p) => p.playerId);
    assert.equal(new Set(launchedIds).size, launchedIds.length, 'each human launches once');
    for (const id of launchedIds) assert.equal(q.lobby.queueByPlayer.has(id), false);
    q.lobby.processMatchQueues();
    assert.equal(q.launched.length, scenario.matches, 'scheduler ticks do not relaunch full groups');
  });
}

test('a later expired group fills AI while an earlier group waits for a new teammate', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 2 });
  q.at(20_000);
  const later = q.join({ count: 3 });
  q.at(50_000);
  const teammate = q.join();
  assert.equal(first.deadlineAt, 110_000);
  assert.equal(teammate.deadlineAt, first.deadlineAt);
  assert.equal(later.deadlineAt, 80_000);
  q.at(80_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1);
  assert.deepEqual(q.launched[0].filter((p) => !p.isBot).map((p) => p.playerId), later.players.map((p) => p.playerId));
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 1);
  assert.deepEqual(q.lobby.matchQueues.get('coop:NORMAL'), [first, teammate]);
  assert.equal(q.queueState(first).count, 3);
  assert.equal(first.deadlineAt, 110_000);
});

test('cancelling a party updates only its remaining group count without resetting deadlines', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 3 });
  q.at(20_000);
  const second = q.join({ count: 2 });
  q.at(30_000);
  const third = q.join({ count: 2 });
  assert.equal(q.queueState(first).count, 3);
  assert.equal(q.queueState(second).count, 4);
  const deadline = second.deadlineAt;
  q.lobby.cancelMatchQueue(third);
  assert.equal(q.queueState(third).status, 'cancelled');
  assert.equal(q.queueState(second).count, 2);
  assert.equal(q.queueState(first).count, 3);
  assert.equal(second.deadlineAt, deadline);
  assert.equal(first.deadlineAt, 61_000);
});

test('a new teammate resets the whole compatible team’s AI deadline, broadcasts it to the room and waits the full interval', (t) => {
  const q = manualQueue(t);
  const room = { code: 'TEST' };
  const first = q.join({ room });
  const queuedAt = first.queuedAt;
  q.at(60_000);
  const second = q.join();
  assert.equal(first.deadlineAt, 120_000);
  assert.equal(second.deadlineAt, first.deadlineAt);
  assert.equal(first.queuedAt, queuedAt, 'original queue order is preserved');
  assert.equal(room.matching.deadlineAt, 120_000);
  assert.equal(q.states.at(-1).deadlineAt, 120_000, 'room members receive the refreshed deadline');
  q.at(61_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0, 'original deadline does not add AI');
  q.at(90_000);
  const third = q.join();
  assert.ok([first, second, third].every((entry) => entry.deadlineAt === 150_000));
  q.at(149_999);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 0);
  assert.equal(first.deadlineAt, 150_000, 'scheduler ticks never reset the deadline');
  q.at(150_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1);
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 1);
});

test('different difficulties, private tickets and parties exceeding capacity do not reset an unrelated team', (t) => {
  const q = manualQueue(t);
  const first = q.join({ count: 3 });
  q.at(30_000);
  const otherDifficulty = q.join({ difficulty: 'HARD' });
  const privateEntry = q.join({ fillBots: false });
  const largeParty = q.join({ count: 2 });
  assert.equal(first.deadlineAt, 61_000);
  q.at(40_000);
  const teammate = q.join();
  assert.equal(first.deadlineAt, 100_000);
  assert.equal(teammate.deadlineAt, first.deadlineAt);
  assert.equal(otherDifficulty.deadlineAt, 90_000);
  assert.equal(privateEntry.deadlineAt, 90_000);
  assert.equal(largeParty.deadlineAt, 90_000);
  q.lobby.processMatchQueues();
  assert.equal(q.launched.length, 1, 'full team starts without waiting for AI');
  assert.equal(q.launched[0].filter((p) => p.isBot).length, 0);
});

test('cancellation does not reset the AI wait and deadlines are sent to existing clients', async () => {
  const a = await player('Countdown A'), b = await player('Countdown B');
  const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
  assert.equal(created.t, 'ok');
  await a.waitFor('room.state', (s) => s.code);
  assert.equal((await a.request({ t: 'match.join', mode: 'coop', difficulty: 'HARD', fillBots: true })).t, 'ok');
  const original = await a.waitFor('match.queue', (m) => m.status === 'queued');
  assert.equal((await b.request({ t: 'match.join', mode: 'coop', difficulty: 'HARD', fillBots: true })).t, 'ok');
  const updated = await a.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
  const joined = await b.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 2);
  assert.ok(updated.deadlineAt >= original.deadlineAt);
  assert.equal(joined.deadlineAt, updated.deadlineAt);
  const room = await a.waitFor('room.state', (s) => s.matching?.deadlineAt === updated.deadlineAt);
  assert.equal(room.matching.deadlineAt, joined.deadlineAt);
  assert.equal((await b.request({ t: 'match.leave' })).t, 'ok');
  const left = await a.waitFor('match.queue', (m) => m.status === 'queued' && m.count === 1);
  assert.equal(left.deadlineAt, updated.deadlineAt, 'leaving does not restart the countdown');
  assert.equal((await a.request({ t: 'match.leave' })).t, 'ok');
});
