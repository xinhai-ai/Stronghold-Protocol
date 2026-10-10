import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { DATA } from './match/harness.js';
import { deserialize } from 'node:v8';
import { encodeMatchCapture } from '../server/match/snapshot.js';
import { Persister } from '../server/persist.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const options = (roomCode) => ({
  roomCode, mode: 'coop', difficulty: 'NORMAL', seed: 42, matchNo: 1,
  seats: [0, 1].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
});
const inspectWorker = new URL('./fixtures/match-worker-inspect.mjs', import.meta.url);
function poolFor(t, config = {}) {
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1, ...config });
  t.after(() => pool.close());
  return pool;
}

test('one configure per lane; concurrent/reused Matches share a frozen owning snapshot before content imports', async (t) => {
  const data = { ...DATA, workerTestMarker: 'owning-server-not-disk' };
  const pool = poolFor(t, { data, lanes: 2, workerUrl: inspectWorker });
  const sent = [];
  for (const lane of pool.lanes) {
    const post = lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage = (message, ...args) => { sent.push({ lane: lane.id, message }); return post(message, ...args); };
  }
  const matches = await Promise.all(['A', 'B', 'C', 'D'].map((key) => pool.create(key, {
    ...options(key), data: { invalidOverride: () => {} },
  })));
  for (const match of matches) {
    assert.deepEqual(await match.invoke('inspectWorkerData'), {
      shared: true, frozen: true, singleton: true, sim: true, content: true, marker: data.workerTestMarker,
    });
    await match.start();
    await match.setLoadout('p_0', {}, {});
    assert.equal((await match.snapshot()).seed, 42);
  }
  for (const lane of pool.lanes) assert.equal(sent.filter((x) => x.lane === lane.id && x.message.type === 'configure').length, 1);
  for (const { message } of sent.filter((x) => x.message.type === 'init')) {
    assert.ok(!Object.hasOwn(message.options, 'data'), 'init must not clone or retain the full dataset');
  }
  const old = matches[0];
  pool.release('A', old);
  const fresh = await pool.create('A', options('A'));
  assert.equal((await fresh.invoke('inspectWorkerData')).shared, true);
  assert.equal(sent.filter((x) => x.message.type === 'configure').length, 2, 'reused room does not reconfigure its lane');
});

test('IPC omits unchanged metadata, sends lifecycle changes, and retries metadata after a reply clone failure', async (t) => {
  const pool = poolFor(t, { workerUrl: inspectWorker });
  const events = [];
  pool.lanes[0].worker.on('message', (event) => events.push(event));
  const match = await pool.create('META', options('META'));
  const ready = events.find((e) => e.type === 'ready');
  assert.equal(ready.meta.order.length, 2);
  await match.start();
  const reply = () => events.findLast((e) => e.type === 'result');
  const before = match.order;
  for (let i = 0; i < 5; i++) await match.handle('p_0', { t: 'b.progress', battleId: 'stale' });
  assert.ok(!Object.hasOwn(reply(), 'meta'), 'unchanged high-frequency replies have no metadata');
  assert.equal(match.order, before, 'proxy keeps the last order instead of allocating another one');
  await match.onDisconnect('p_0');
  assert.equal(reply().meta.order[0].connected, false);
  assert.equal(match.order[0].connected, false);
  await match.onReconnect('p_0');
  assert.equal(reply().meta.order[0].connected, true);
  assert.equal(match.order[0].connected, true);
  const seq = match._battleSeq;
  await assert.rejects(match.invoke('inspectMetadataCloneFailure'), /could not be cloned/);
  await match.invoke('publicView');
  assert.equal(reply().meta._battleSeq, seq + 1, 'failed reply did not advance the baseline');
  assert.equal(match._battleSeq, seq + 1);
  await match.onLeave('p_1');
  assert.equal(match.order[1].left, true);
  assert.equal(reply().meta.order[1].left, true);
  pool.release('META', match);
  const fresh = await pool.create('META', options('META'));
  assert.equal(fresh.order[1].left, false, 'new instance gets a full independent metadata baseline');
});

test('shared configuration timeout rejects all reserved Matches and clears assignments', async (t) => {
  const pool = poolFor(t, { data: { hangConfigure: true }, timeoutMs: 100,
    workerUrl: new URL('./fixtures/match-worker-hang.mjs', import.meta.url) });
  const starts = ['A', 'B', 'C'].map((key) => assert.rejects(pool.create(key, options(key)), /timed out/));
  await Promise.all(starts);
  assert.equal(pool.stats().failedLanes, 1);
  assert.equal(pool.stats().rooms, 0);
  assert.equal(pool.assignments.size, 0);
  assert.equal(pool.lanes[0].pending.size, 0);
  await assert.rejects(pool.create('NEXT', options('NEXT')), /no healthy/);
});

test('uncloneable lane configuration is isolated and does not remain available to new Matches', async (t) => {
  const pool = poolFor(t, { data: { invalid: () => {} } });
  await Promise.all(['A', 'B'].map((key) => assert.rejects(pool.create(key, options(key)), { name: 'DataCloneError' })));
  assert.equal(pool.stats().failedLanes, 1);
  assert.equal(pool.stats().rooms, 0);
  assert.equal(pool.assignments.size, 0);
  await assert.rejects(pool.create('NEXT', options('NEXT')), /no healthy/);
});

test('remote persistence forwards owned capture bytes without exposing a large capture object on the main thread', async (t) => {
  const pool = poolFor(t, { workerUrl: inspectWorker });
  const match = await pool.create('SAVE', options('SAVE'));
  await match.invoke('inspectFixedClock', Date.now());
  await match.start();
  const expected = await match.snapshot();
  const first = await match.captureSnapshotBytes();
  assert.ok(first instanceof Uint8Array && first.byteLength > 0);
  assert.equal(first.buffer.byteLength, first.byteLength, 'owned allocation, not a pooled Buffer slab');
  assert.deepEqual(encodeMatchCapture(deserialize(first)), expected);
  let saved, forwarded;
  const persister = new Persister({ registry: { all: () => [] },
    lobby: { rooms: new Map(), persistenceMatches: () => [{ key: 'SAVE', match }] },
    store: { async saveSerialized(bytes) { saved = JSON.parse(bytes.toString()); return true; } } });
  t.after(() => persister.encoder.close());
  match.captureSnapshot = () => { throw new Error('raw capture must not reach the main thread'); };
  const request = persister.encoder.request.bind(persister.encoder);
  persister.encoder.request = (type, payload, transfer) => {
    if (type === 'checkpointBytes') {
      forwarded = payload.bytes;
      assert.equal(Object.hasOwn(payload, 'capture'), false);
      assert.deepEqual(transfer, [payload.bytes.buffer]);
    }
    return request(type, payload, transfer);
  };
  assert.equal(await persister.flush('test'), true);
  assert.deepEqual(saved.matches.SAVE, expected);
  assert.equal(forwarded.byteLength, 0, 'main thread relinquishes ownership, without deserializing the capture');
  await match.invoke('inspectInvalidCapture', true);
  assert.equal(await persister.flush('bad'), true, 'a single capture failure still permits other state saving');
  assert.equal(persister.failures, 1);
  assert.deepEqual(saved.matches.SAVE, expected, 'bad remote capture keeps the last good checkpoint');
  await match.invoke('inspectInvalidCapture', false);
  assert.equal(await persister.flush('good'), true);
  assert.deepEqual(saved.matches.SAVE, expected);
  await match.invoke('inspectCapturePhase', 'COMBAT');
  assert.equal(await match.captureSnapshotBytes(), null, 'unsafe phases do not serialize a fresh checkpoint');
});

test('production Worker encodes broadcasts/unicasts and room/queue routing reuses the exact bytes for replay', async (t) => {
  const pool = poolFor(t);
  const received = [];
  const packets = [];
  pool.lanes[0].worker.on('message', (message) => packets.push(message));
  const match = await pool.create('WIRE', options('WIRE'), {
    broadcast: (msg, encoded) => received.push({ msg, encoded }),
    send: (playerId, msg, encoded) => received.push({ playerId, msg, encoded }),
  });
  await match.start();
  assert.ok(received.some((x) => x.msg.t === 'm.public' && !x.playerId));
  assert.ok(received.some((x) => x.msg.t === 'm.private' && x.playerId === 'p_0'));
  for (const { msg, encoded } of received) assert.deepEqual(JSON.parse(encoded), msg);
  for (const packet of packets.filter((p) => p.type === 'send' || p.type === 'broadcast')) {
    assert.equal(typeof packet.kind, 'string');
    assert.equal(typeof packet.encoded, 'string');
    assert.equal(Object.hasOwn(packet, 'msg'), false, 'valid frames do not clone a redundant object graph');
  }
  const malformed = { t: 'malformed' };
  malformed.self = malformed;
  await match.invoke('broadcast', malformed);
  assert.equal(received.at(-1).encoded, null, 'malformed frames retain the old non-throwing encoding fallback');
  assert.equal(pool.stats().failedLanes, 0);
  assert.equal((await match.snapshot()).seed, 42);

  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: quiet, getData: () => DATA });
  t.after(() => lobby.shutdown());
  const session = registry.create('Player');
  lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' });
  const room = lobby.roomOf(session);
  const ctx = { results: new Map(), members: [{ playerId: session.playerId, isBot: false, left: false }] };
  session.connected = true;
  session.activeMatchCtx = ctx;
  const wire = [];
  session.ws = { readyState: 1, bufferedAmount: 0, send: (bytes) => wire.push(bytes) };
  // If any main-thread path re-encodes this trusted Worker message, the test fails.
  const msg = { t: 'm.public', marker: 'worker-encoded', toJSON() { throw new Error('main-thread re-encode'); } };
  const encoded = '{"t":"m.public","marker":"worker-encoded"}';
  lobby.matchBroadcast(room, ctx, msg, encoded);
  assert.equal(ctx.lastPublic, encoded);
  lobby.queueMatchBroadcast(ctx, msg, encoded);
  assert.equal(ctx.lastPublic, encoded);
  const result = { t: 'm.result', toJSON: msg.toJSON };
  const resultBytes = '{"t":"m.result"}';
  lobby.matchSend(room, ctx, session.playerId, result, resultBytes);
  assert.equal(ctx.results.get(session.playerId), resultBytes);
  lobby.queueMatchSend(ctx, session.playerId, result, resultBytes);
  assert.equal(ctx.results.get(session.playerId), resultBytes);
  assert.deepEqual(wire, [encoded, encoded, resultBytes, resultBytes]);
});
