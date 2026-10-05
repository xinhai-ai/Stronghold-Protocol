import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { SimulationPool } from '../server/workers/pool.js';
import { startServer } from '../server/index.js';

function setup(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: StubMatch, getData: () => ({}) });
  t.after(() => lobby.shutdown());
  const player = () => { const s = registry.create('test'); s.connected = true; return s; };
  const start = (room, players) => {
    const entry = lobby.makeQueueEntry({ room, mode: 'coop', difficulty: 'NORMAL', players });
    assert.deepEqual(lobby.startQueuedMatch(entry, players), { ok: true });
    return registry.byId(players[0].playerId).activeMatchCtx;
  };
  return { registry, lobby, player, start };
}

test('closing a matchmaking room unbinds external teammates when its last room member leaves', (t) => {
  const { registry, lobby, player, start } = setup(t);
  for (let i = 0; i < 25; i++) {
    const host = player(), guest = player();
    lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
    const room = lobby.getRoom(host.roomCode);
    const ctx = start(room, [...room.seats.filter(Boolean), { seat: 1, playerId: guest.playerId, name: 'guest', isBot: false, connected: true }]);
    lobby.removeMember(room, host.playerId);
    assert.equal(ctx.disposed, true);
    assert.equal(ctx.match.disposed, true);
    assert.equal(guest.activeMatchCtx, null, 'the surviving public teammate must not retain the disposed Match');
  }
  assert.equal(lobby.rooms.size, 0);
  assert.equal(lobby.activeQueueMatches.size, 0);
  assert.equal([...registry.all()].filter((s) => s.activeMatchCtx).length, 0);
});

test('shutdown disposes standalone matches and unbinds their surviving sessions', (t) => {
  const { lobby, player, start } = setup(t);
  const s = player();
  const ctx = start(null, [{ seat: 0, playerId: s.playerId, name: s.name, isBot: false, connected: true }]);
  assert.equal(lobby.stats().standaloneMatches, 1);
  assert.equal(lobby.stats().matches, 1);
  lobby.shutdown();
  assert.equal(ctx.match.disposed, true);
  assert.equal(s.activeMatchCtx, null);
  assert.equal(lobby.activeQueueMatches.size, 0);
});

test('settled Worker cancel handles release task inputs and progress callbacks', async (t) => {
  const pool = new SimulationPool({ size: 1, workerUrl: new URL('./fixtures/pool-worker.mjs', import.meta.url) });
  t.after(() => pool.close());
  const handle = pool.submit('burn', { ms: 10, value: 'done' }, { onProgress: () => {} });
  const task = [...pool.slots][0].task;
  assert.ok(task.payload);
  assert.equal(await handle.promise, 'done');
  assert.equal(task.payload, null);
  assert.equal(task.onProgress, null);
  assert.equal(task.resolve, null);
  assert.equal(task.slot, null);
  handle.cancel();
  assert.equal(pool.stats().cancelled, 0);
});

test('health exposes process RSS, main heap, bounded cache, and socket send queues', async (t) => {
  const srv = await startServer({ port: 0, quiet: true, workers: 0, store: null });
  t.after(() => srv.close());
  const health = await (await fetch(srv.url + '/healthz')).json();
  assert.ok(health.memory.rss > 0);
  assert.ok(health.memory.heapUsed > 0);
  assert.ok(health.memory.heapUsed <= health.memory.heapTotal);
  assert.ok(health.staticCache.gzipBytes <= health.staticCache.gzipLimitBytes);
  assert.deepEqual(health.socketBuffers, { total: 0, max: 0 });
});
