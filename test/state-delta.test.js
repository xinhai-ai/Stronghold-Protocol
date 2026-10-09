import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffState, applyStatePatch, StateReceiver } from '../shared/stateDelta.js';
import { negotiateStateDelta, prepareStateFrame, resetStateDelta } from '../server/stateTransport.js';
import { send, NET_DEFAULTS } from '../server/net.js';
import { Net } from '../public/js/net.js';
import { validateC2S } from '../shared/protocol.js';
import { makeMatch, legalTileFor } from './match/harness.js';

const makeView = (extra = {}) => ({ t: 'm.private', playerId: 'p1', funds: 10,
  board: [{ uid: 1, row: 2, col: 3, items: [] }], padding: 'unchanged'.repeat(300), ...extra });
const socket = () => ({ readyState: 1, bufferedAmount: 0, frames: [],
  send(data) { this.frames.push(JSON.parse(data)); }, terminate() { this.readyState = 3; } });
const frame = (ws, view) => prepareStateFrame(ws, view, JSON.stringify(view));

test('JSON exactness: object deletes/adds, nulls, array length/type changes, nested player/board fields', () => {
  const before = { t: 'm.public', removed: 2, nullable: { x: 1 }, players: [{ hp: 12, board: [null, { col: 4 }] }], empty: [] };
  const after = { t: 'm.public', added: false, nullable: null, players: [{ hp: 8, board: [null, { col: 5, dir: 'UP' }] }], empty: [1] };
  const saved = structuredClone(before);
  assert.deepEqual(applyStatePatch(before, diffState(before, after)), after);
  assert.deepEqual(before, saved);
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const value = (depth) => {
    const n = random();
    if (!depth) return [null, true, false, n, String(n)][n % 5];
    if (n % 3 === 0) return Array.from({ length: n % 5 }, () => value(depth - 1));
    if (n % 3 === 1) return Object.fromEntries(Array.from({ length: n % 5 }, (_, i) => ['k' + i, value(depth - 1)]));
    return value(0);
  };
  for (let i = 0; i < 500; i++) {
    const a = { t: 'm.private', data: value(4) }, b = { t: 'm.private', data: value(4) };
    assert.deepEqual(applyStatePatch(a, diffState(a, b)), b);
  }
});

test('unsafe/malformed patches are rejected atomically; previous views and prototypes stay intact', () => {
  const base = makeView();
  for (const op of [
    [['__proto__', 'polluted'], true], [['constructor', 'prototype', 'polluted'], true],
    [['board', -1], null], [['board', '0'], null], [['board', 0]], [['absent', 'x'], 1],
    [['t'], 'm.public'], [[], null], [['funds'], 1, 2],
  ]) {
    assert.throws(() => applyStatePatch(base, [[['funds'], 0], op]));
    assert.equal(base.funds, 10);
    assert.equal({}.polluted, undefined);
  }
  assert.equal(diffState({}, JSON.parse('{"__proto__":{"x":1}}')), null);
  assert.equal(diffState({ t: 'm.private' }, {
    t: 'm.private', ...Object.fromEntries(Array.from({ length: 4097 }, (_, i) => ['k' + i, i])),
  }), null, 'bounded op count falls back to full');
  const deep = (leaf) => { for (let i = 0; i < 70; i++) leaf = { value: leaf }; return { t: 'm.private', nested: leaf }; };
  assert.equal(diffState(deep(1), deep(2)), null, 'bounded path depth falls back to full');
});

test('negotiation: legacy/unknown versions retain exact full JSON, new clients get full then small delta', () => {
  const a = makeView(), b = makeView({ funds: 9 });
  for (const version of [undefined, 0, 2]) {
    const ws = socket();
    negotiateStateDelta(ws, version);
    assert.equal(frame(ws, a).data, JSON.stringify(a));
  }
  const ws = socket();
  negotiateStateDelta(ws, 1);
  const first = frame(ws, a);
  assert.deepEqual(JSON.parse(first.data).full, a);
  first.commit();
  const next = frame(ws, b), wire = JSON.parse(next.data);
  assert.deepEqual(wire.patch, [[['funds'], 9]]);
  assert.equal(wire.base, JSON.parse(first.data).seq);
  assert.ok(Buffer.byteLength(next.data) < Buffer.byteLength(first.data) / 10);
  const rx = new StateReceiver();
  assert.deepEqual(rx.receive(JSON.parse(first.data)).message, a);
  assert.deepEqual(rx.receive(wire).message, b);
});

test('a broadcast shares encoded transition; mutable source views cannot corrupt the baseline', () => {
  const sockets = [socket(), socket(), socket(), socket()];
  const a = makeView();
  for (const ws of sockets) { negotiateStateDelta(ws, 1); const f = frame(ws, a); f.commit(); }
  a.board[0].col = 7; // like an upstream view borrowing a mutable game array
  const b = makeView({ funds: 8 });
  const encodings = sockets.map((ws) => frame(ws, b).data);
  assert.ok(encodings.every((s) => s === encodings[0]));
  assert.deepEqual(JSON.parse(encodings[0]).patch, [[['funds'], 8]]);
});

test('failed sends do not advance the baseline; reliable state retains backpressure thresholds and FIFO', () => {
  const ws = socket();
  negotiateStateDelta(ws, 1);
  assert.equal(send(ws, makeView()), true);
  ws.send = () => { throw new Error('send failure'); };
  assert.equal(send(ws, makeView({ funds: 9 })), false);
  ws.send = function (data) { this.frames.push(JSON.parse(data)); };
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  assert.equal(send(ws, makeView({ funds: 8 })), true, 'state is reliable, never droppable');
  assert.equal(ws.frames[1].base, ws.frames[0].seq);
  assert.deepEqual(ws.frames[1].patch, [[['funds'], 8]]);
  assert.equal(send(ws, { t: 'ok', rid: 1 }), true);
  assert.equal(ws.frames[2].t, 'ok');
  ws.bufferedAmount = NET_DEFAULTS.hardBufferBytes + 1;
  assert.equal(send(ws, makeView({ funds: 7 })), false);
  assert.equal(ws.readyState, 3);
});

test('public/private baselines and different owners stay isolated; reset and large edits use full', () => {
  const ws = socket(), other = socket();
  for (const s of [ws, other]) negotiateStateDelta(s, 1);
  send(ws, makeView());
  send(ws, { t: 'm.public', players: ['public'], padding: 'x'.repeat(2000) });
  send(other, makeView({ playerId: 'p2', funds: 77 }));
  send(ws, makeView({ funds: 9 }));
  assert.equal(ws.frames[2].base, ws.frames[0].seq);
  assert.equal(other.frames[0].full.funds, 77);
  resetStateDelta(ws);
  send(ws, makeView({ funds: 8 }));
  assert.ok(ws.frames.at(-1).full);
  send(ws, { t: 'm.private', entirely: 'different' });
  assert.ok(ws.frames.at(-1).full);
});

test('gap/malformed delta emits no partial state; resync coalesces across channels until full recovery', () => {
  const rx = new StateReceiver(), a = makeView();
  rx.receive({ kind: a.t, seq: 1, full: a });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 3, base: 2, patch: [[['funds'], 8]] }), { message: null, resync: true });
  assert.deepEqual(rx.receive({ kind: 'm.public', seq: 4, base: 1, patch: [] }), { message: null, resync: false });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 5, base: 3, patch: [] }), { message: null, resync: false });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 6, full: makeView({ funds: 8 }) }).message, makeView({ funds: 8 }));
  rx.receive({ kind: 'm.public', seq: 7, full: { t: 'm.public' } });
  const bad = rx.receive({ kind: a.t, seq: 8, base: 6, patch: [[['board', 0, 'col'], 1], [['absent', 'x'], 1]] });
  assert.equal(bad.resync, true);
  assert.equal(a.board[0].col, 3);
  rx.reset();
  assert.equal(rx.states.size, 0);
});

test('client dispatch reconstructs original events before resolving operation ok; duplicates do not re-emit', () => {
  const net = new Net({ url: 'ws://test/ws' }), ws = socket(), events = [], requests = [];
  net.request = (t) => { requests.push({ t }); return Promise.resolve(); };
  net.on('m.private', (msg) => events.push(msg));
  net.on('ok', () => assert.equal(events.at(-1).funds, 9));
  negotiateStateDelta(ws, 1);
  send(ws, makeView());
  send(ws, makeView({ funds: 9 }));
  for (const f of ws.frames) net._onMessage(JSON.stringify(f));
  net._onMessage(JSON.stringify(ws.frames[1]));
  assert.equal(events.length, 2);
  assert.equal(events[0].funds, 10);
  net._onMessage('{"t":"ok","rid":1}');
  net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.private', seq: 100, base: 99, patch: [] }));
  assert.deepEqual(requests, [{ t: 'state.resync' }]);
  net._teardownSocket();
  assert.equal(net._states.states.size, 0);
  assert.equal(validateC2S({ t: 'hello', name: 'test', stateDelta: 1 }), null);
  assert.equal(validateC2S({ t: 'state.resync' }), null);
  assert.notEqual(validateC2S({ t: 'hello', name: 'test', stateDelta: '1' }), null);
});

test('client retries rate-limited state recovery quietly, stops on full delivery and on disconnect', async () => {
  const callbacks = new Map();
  let timerId = 0, attempts = 0;
  const net = new Net({ url: 'ws://test/ws', timers: {
    setTimeout(fn) { callbacks.set(++timerId, fn); return timerId; },
    clearTimeout(id) { callbacks.delete(id); }, clearInterval() {},
  } });
  net.request = () => { attempts++; return Promise.reject(new Error('RATE')); };
  net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.private', seq: 2, base: 1, patch: [] }));
  await Promise.resolve();
  assert.equal(attempts, 1);
  const [id, retry] = [...callbacks][0]; callbacks.delete(id); retry();
  assert.equal(attempts, 2);
  net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.private', seq: 3, full: makeView() }));
  assert.equal(callbacks.size, 0);
  net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.private', seq: 5, base: 4, patch: [] }));
  assert.equal(attempts, 3);
  net._teardownSocket();
  assert.equal(callbacks.size, 0);
});

test('complete scripted match: every reconstructed state equals the original across purchases, movement and phases', () => {
  const h = makeMatch({ humans: 4, seed: 7, fake: true, captureFrames: false,
    script: () => ({ duration: 2, leaks: {}, bossDps: 1e9 }) });
  const peers = new Map(h.m.order.map((ps) => {
    const ws = socket(); negotiateStateDelta(ws, 1);
    return [ps.playerId, { ws, rx: new StateReceiver() }];
  }));
  const phases = new Set();
  let checked = 0, patches = 0;
  const deliver = (id, msg, encoded = JSON.stringify(msg)) => {
    if (!['m.public', 'm.private', 'm.result'].includes(msg.t)) return;
    const { ws, rx } = peers.get(id);
    assert.equal(send(ws, msg, encoded), true);
    const wire = ws.frames.pop();
    if (wire.t === 'm.state') {
      const decoded = rx.receive(wire);
      assert.equal(decoded.resync, false);
      assert.deepEqual(decoded.message, JSON.parse(encoded), `${msg.t} R${h.m.round} ${h.m.phase}`);
      checked++; if (wire.patch) patches++;
      if (msg.phase) phases.add(msg.phase);
    } else if (wire.t === 'm.result') rx.reset();
  };
  h.onSend.push(deliver);
  h.onBroadcast.push((msg) => {
    const encoded = JSON.stringify(msg);
    for (const id of peers.keys()) deliver(id, msg, encoded);
  });
  try {
    h.start(); h.toPrep();
    const ps = h.ps('p_0');
    assert.ok(h.m.handle(ps.playerId, { t: 'g.freeze' }).ok);
    const slot = ps.privateView().shop.slots.findIndex((s) => s?.kind === 'chess' && s.price <= ps.funds);
    assert.ok(slot >= 0);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.buy', slot }).ok);
    const piece = ps.hand.find((p) => p?.kind === 'chess');
    const tile = legalTileFor(h.m, ps, piece.id);
    assert.ok(tile);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'UP' }).ok);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.sell', uid: piece.uid }).ok);
    assert.ok(h.drive(() => h.ended !== null));
    assert.ok(checked > 100 && patches > 50);
    assert.ok(phases.has('PREP') && phases.has('INFO_CHECK') && phases.has('RESULT'));
    assert.equal(h.m.errorCount, 0);
  } finally { h.m.dispose(); }
});
