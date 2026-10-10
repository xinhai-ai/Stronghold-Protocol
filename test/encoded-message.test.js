import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodedMessage } from '../server/workers/matchPool.js';
import { send } from '../server/net.js';
import { negotiateStateDelta } from '../server/stateTransport.js';
import { StateReceiver } from '../shared/stateDelta.js';

const view = (funds = 10) => ({ t: 'm.private', playerId: 'owner', funds, board: [{ col: 3 }], pad: 'x'.repeat(2000) });
const socket = () => ({ readyState: 1, bufferedAmount: 0, frames: [], send(data) { this.frames.push(data); } });

test('legacy routing/sending needs no decoded object; old hooks can enumerate/read/serialize a full view lazily', () => {
  const expected = view();
  const bytes = JSON.stringify(expected);
  const msg = encodedMessage(expected.t, bytes), ws = socket();
  const parse = JSON.parse;
  let reads = 0;
  JSON.parse = (...args) => { reads++; return parse(...args); };
  try {
    assert.equal(msg.t, expected.t);
    assert.equal(send(ws, msg, bytes), true);
    assert.equal(reads, 0, 'legacy wire forwarding does not materialize the view');
    assert.equal(ws.frames[0], bytes);
    assert.deepEqual({ ...msg }, expected);
    assert.equal(reads, 1);
    assert.equal(msg.funds, 10);
    assert.equal('playerId' in msg, true);
    assert.equal(JSON.stringify(msg), bytes);
    assert.equal(reads, 1, 'the same hook view is decoded once');
  } finally { JSON.parse = parse; }
});

test('modern routing parses one encoding-owned snapshot; callback mutations cannot change an existing baseline', () => {
  const ws = socket();
  negotiateStateDelta(ws, 1);
  const bytes = JSON.stringify(view());
  const msg = encodedMessage('m.private', bytes);
  const parse = JSON.parse;
  let reads = 0;
  JSON.parse = (...args) => { reads++; return parse(...args); };
  try {
    assert.equal(send(ws, msg, bytes), true);
    assert.equal(reads, 1, 'no decoded IPC object plus second JSON parse');
  } finally { JSON.parse = parse; }
  const rx = new StateReceiver();
  assert.deepEqual(rx.receive(parse(ws.frames[0])).message, view());
  msg.board[0].col = 99;
  msg.funds = 1000;
  assert.equal(send(ws, encodedMessage('m.private', JSON.stringify(view(9))), JSON.stringify(view(9))), true);
  const frame = parse(ws.frames[1]);
  assert.deepEqual(frame.patch, [[['funds'], 9]]);
  assert.deepEqual(rx.receive(frame).message, view(9));
});

test('one public wrapper shares a delta encoding while private wrappers/connection baselines stay isolated', () => {
  const publicView = { ...view(), t: 'm.public' };
  const bytes = JSON.stringify(publicView), msg = encodedMessage('m.public', bytes);
  const peers = [socket(), socket()];
  for (const ws of peers) { negotiateStateDelta(ws, 1); assert.equal(send(ws, msg, bytes), true); }
  assert.equal(peers[0].frames[0], peers[1].frames[0]);
  for (let i = 0; i < peers.length; i++) {
    const privateBytes = JSON.stringify({ ...view(), playerId: `p${i}` });
    send(peers[i], encodedMessage('m.private', privateBytes), privateBytes);
  }
  assert.equal(JSON.parse(peers[0].frames[1]).full.playerId, 'p0');
  assert.equal(JSON.parse(peers[1].frames[1]).full.playerId, 'p1');
});
