import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Network, SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { CooperativeQueue } from '../server/cooperative.js';
import { RealScheduler } from '../server/match/scheduler.js';
import { MatchMessaging } from '../server/match/match/messaging.js';

function socket(network) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.frames = [];
  ws.pings = 0;
  ws.send = (data, callback) => { ws.frames.push(JSON.parse(data)); callback?.(); };
  ws.ping = () => { ws.pings++; };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  ws.terminate = ws.close;
  network.handleConnection(ws);
  return ws;
}

async function drain(network) {
  for (let n = 0; network._fanout.length && n < 1000; n++) await nextTurn();
  assert.equal(network._fanout.length, 0);
}

test('2500-socket broadcasts yield to requests, preserve public order, and skip closed sockets', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 2500 }, () => socket(network));
  network.broadcast({ t: 'first' });
  assert.ok(sockets.filter((s) => s.frames.length).length <= 128);
  assert.equal(sockets.at(-1).frames.length, 0);
  sockets.at(-1).emit('message', Buffer.from('{"t":"ping","c":123,"rid":1}'), false);
  assert.equal(sockets.at(-1).frames[0].t, 'pong', 'a request runs before the broadcast finishes');
  const removed = sockets[1000];
  removed.close();
  network.broadcast({ t: 'second' });
  await drain(network);
  for (const ws of sockets) {
    if (ws === removed) { assert.deepEqual(ws.frames, []); continue; }
    assert.deepEqual(ws.frames.filter((m) => m.t !== 'pong').map((m) => m.t), ['first', 'second']);
  }
  assert.equal(network.diagnostics.stats().handlerMs.ping.count, 1);
});

test('batched heartbeat checks each socket once, retains pong liveness, and stops during shutdown', async (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.heartbeat();
  network.heartbeat(); // overlapping calls do not ping the first batch twice
  await drain(network);
  assert.ok(sockets.every((s) => s.pings === 1));
  sockets[0].emit('pong');
  network.heartbeat();
  await drain(network);
  assert.equal(sockets[0].pings, 2);
  assert.ok(sockets.slice(1).every((s) => s.readyState === 3));
  network.beginShutdown();
  network.heartbeat();
  assert.equal(sockets[0].pings, 2);
});

test('closing cancels deferred fanout without retaining its recipients', async () => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  const sockets = Array.from({ length: 300 }, () => socket(network));
  network.broadcast({ t: 'notice' });
  network.close();
  await nextTurn();
  assert.equal(sockets.at(-1).frames.length, 0);
  assert.equal(network._fanout.length, 0);
  assert.equal(network._fanoutImmediate, null);
});

test('shared CPU queue enforces an aggregate budget and FIFO fairness across continuations', () => {
  let now = 0;
  const turns = [];
  const queue = new CooperativeQueue({ now: () => now, schedule: (fn) => { turns.push(fn); return fn; },
    cancel: (fn) => turns.splice(turns.indexOf(fn), 1) });
  const order = [];
  queue.enqueue(() => { order.push('A1'); now += 8; queue.enqueue(() => order.push('A2')); });
  queue.enqueue(() => { order.push('B'); now += 8; });
  turns.shift()();
  assert.deepEqual(order, ['A1']);
  turns.shift()();
  assert.deepEqual(order, ['A1', 'B']);
  turns.shift()();
  assert.deepEqual(order, ['A1', 'B', 'A2']);
  const cancelled = queue.enqueue(() => assert.fail('cancelled work ran'));
  queue.remove(cancelled);
  assert.equal(turns.length, 0);
});

test('real schedulers cancel queued CPU work on timer cancellation and disposal', async () => {
  const a = new RealScheduler(), b = new RealScheduler();
  const order = [];
  a.clearTimeout(a.setWork(() => assert.fail('cancelled work ran')));
  a.setWork(() => assert.fail('disposed work ran'));
  b.setWork(() => order.push('B'));
  a.dispose();
  await nextTurn();
  assert.deepEqual(order, ['B']);
  b.dispose();
});

test('private-state deduplication supplies the same encoded bytes without encoding twice', () => {
  let encodes = 0;
  const view = { t: 'm.private', toJSON() { encodes++; return { t: 'm.private', coins: 10 }; } };
  const ps = { playerId: 'p', privateView: () => view };
  const messages = [];
  const match = Object.assign(new MatchMessaging(), { players: new Map([['p', ps]]),
    sendFn: (pid, msg, encoded) => { messages.push({ pid, msg, encoded }); return true; } });
  match._sendPrivate(ps, false);
  assert.equal(encodes, 1);
  assert.equal(messages[0].encoded, '{"t":"m.private","coins":10}');
  match._sendPrivate(ps, false);
  assert.equal(messages.length, 1);
});

test('linear party packing matches oldest-first packing for mixed sizes, private and removed tickets', () => {
  const oldPacking = (bucket) => {
    let remaining = bucket.filter((e) => e && !e.removed);
    const groups = [];
    while (remaining.length) {
      const group = Lobby.prototype.selectMatchEntries(remaining);
      groups.push(group);
      remaining = remaining.filter((e) => !group.includes(e));
    }
    return groups;
  };
  let seed = 9327;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 100; run++) {
    const bucket = Array.from({ length: 200 }, (_, id) => ({ id,
      players: Array.from({ length: 1 + random() % 4 }, () => ({})),
      fillBots: random() % 3 !== 0, removed: random() % 11 === 0 }));
    assert.deepEqual(Lobby.prototype.groupMatchEntries(bucket), oldPacking(bucket));
  }
});

test('large match queue starts all due groups and broadcasts remaining counts only once', () => {
  const bucket = Array.from({ length: 2500 }, (_, id) => ({ id, mode: 'coop', difficulty: 'NORMAL',
    players: [{ playerId: 'p' + id }], fillBots: true, deadlineAt: id === 2499 ? 10000 : 0 }));
  let broadcasts = 0, started = 0;
  const lobby = Object.assign(Object.create(Lobby.prototype), { now: () => 100, matchQueues: new Map([['coop:NORMAL', bucket]]),
    removeQueueReferences: (entry) => { entry.removed = true; },
    broadcastQueueCounts: () => broadcasts++, startQueuedMatch: () => started++ });
  lobby.processMatchQueues();
  assert.equal(started, 625);
  assert.equal(broadcasts, 1);
  assert.equal(lobby.matchQueues.size, 0);
});
