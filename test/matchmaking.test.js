import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
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
  assert.equal(srv.lobby.stats().rooms, 0);
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
