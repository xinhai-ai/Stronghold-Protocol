import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { ERR } from '../shared/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
function fixture(t, checkChat) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, nameModeration: { checkChat }, log: quiet });
  t.after(() => lobby.shutdown());
  const session = registry.create('Chat');
  session.connected = true;
  lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' });
  const room = lobby.roomOf(session);
  const sent = [];
  const match = {
    handle: (id, msg) => { sent.push({ id, ...msg }); return { ok: true }; },
    dispose() {},
  };
  const ctx = { match, room, live: true, disposed: false, ended: false };
  room.match = match;
  room.matchCtx = ctx;
  return { registry, lobby, session, room, match, ctx, sent };
}

for (const label of ['left', 'new match', 'replaced socket', 'disconnected', 'shutdown']) {
  test(`a late chat approval is discarded after ${label}`, async (t) => {
    const job = Promise.withResolvers();
    const { lobby, session, room, match, sent } = fixture(t, () => job.promise);
    const pending = lobby.routeGame(session, { t: 'g.chat', text: '审核中' });
    await turn();
    if (label === 'left') { room.match = null; room.matchCtx = null; session.roomCode = null; }
    if (label === 'new match') {
      room.match = { ...match, handle: () => assert.fail('old chat cannot enter new game') };
      room.matchCtx = { match: room.match, live: true };
    }
    if (label === 'replaced socket') session.ws = {};
    if (label === 'disconnected') session.connected = false;
    if (label === 'shutdown') lobby.shutdown();
    job.resolve({ allowed: true });
    assert.equal((await pending).error, ERR.WRONG_PHASE);
    assert.deepEqual(sent, []);
    assert.equal(lobby.chatReviews.has(session), false);
  });
}

test('review requests are bounded per player; invalid or spectator messages never reach the provider', async (t) => {
  const job = Promise.withResolvers();
  let calls = 0;
  const { lobby, registry, session, room, sent } = fixture(t, () => { calls++; return job.promise; });
  assert.equal(lobby.routeGame(session, { t: 'g.chat', text: '中'.repeat(21) }).error, ERR.BAD_MSG);
  const observer = registry.create('Observer');
  observer.connected = true;
  observer.roomCode = room.code;
  room.spectators.push({ playerId: observer.playerId });
  assert.equal(lobby.routeGame(observer, { t: 'g.chat', text: '旁观者' }).error, ERR.SPECTATOR);
  assert.equal(calls, 0);
  const pending = lobby.routeGame(session, { t: 'g.chat', text: ' hello ' });
  assert.equal(lobby.routeGame(session, { t: 'g.chat', text: 'second' }).error, ERR.RATE);
  await turn();
  assert.equal(calls, 1);
  job.resolve({ allowed: true });
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(sent.map((m) => m.text), ['hello']);
});

test('synchronous reviewer failure fails open exactly once; dispatch exceptions never retry mutations', async (t) => {
  const { lobby, session, match, sent } = fixture(t, () => { throw new Error('private reviewer failure'); });
  assert.deepEqual(await lobby.routeGame(session, { t: 'g.chat', text: 'hello' }), { ok: true });
  assert.equal(sent.length, 1);
  let dispatches = 0;
  match.handle = () => { dispatches++; throw new Error('mutation failed'); };
  assert.equal((await lobby.routeGame(session, { t: 'g.chat', text: 'later' })).error, ERR.INTERNAL);
  assert.equal(dispatches, 1);
});
