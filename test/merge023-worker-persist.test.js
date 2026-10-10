import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './match/harness.js';
import { snapshotMatch, restoreMatch } from '../server/match/snapshot.js';
import { createRngFromState } from '../server/sim/rng.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { sessionDoc, roomDoc } from '../server/persist.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';

const character = DATA.chess.chess_char_1_06_a.charId;
const ops = { [character]: { potential: 2, cultivate: 1 } };
const seats = [{ seat: 0, playerId: 'p_0', name: 'Merge', isBot: false, connected: true, ops }];
const quiet = { warn() {}, error() {}, info() {}, debug() {} };

test('0.2.3 operator settings and setup revision survive the existing checkpoint format', () => {
  const first = makeMatch({ mode: 'solo', seats, seed: 901, fake: true }).start();
  const second = makeMatch({ mode: 'solo', seats, seed: 901, fake: true });
  try {
    assert.deepEqual(first.m.players.get('p_0').ops, ops);
    assert.deepEqual(first.m.requestSetupReroll('p_0', 0), { ok: true });
    const doc = snapshotMatch(first.m);
    assert.equal(doc.setupRevision, 1);
    assert.deepEqual(doc.players[0].ops, ops);
    assert.equal(restoreMatch(second.m, doc, { createRngFromState, log: quiet }), true);
    assert.equal(second.m.setupRevision, 1);
    assert.deepEqual(second.m.players.get('p_0').ops, ops);
    second.m.onReconnect('p_0');
    assert.equal(second.m.requestSetupReroll('p_0', 0).error, 'BAD_TARGET');
  } finally {
    first.m.dispose();
    second.m.dispose();
  }
});

test('0.2.3 setup rerolls and loadout settings are available in room Workers', async (t) => {
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1 });
  t.after(() => pool.close());
  const match = await pool.create('merge023', {
    roomCode: 'MERG', mode: 'solo', difficulty: 'NORMAL', seed: 901, matchNo: 1, seats,
  });
  await match.start();
  assert.deepEqual(await match.requestSetupReroll('p_0', 0), { ok: true });
  const doc = await match.snapshot();
  assert.equal(doc.setupRevision, 1);
  assert.deepEqual(doc.players[0].ops, ops);
  const restored = await pool.create('merge023-restored', {
    roomCode: 'MERG', mode: 'solo', difficulty: 'NORMAL', seed: 901, matchNo: 1, seats,
  }, {}, doc);
  const restoredDoc = await restored.snapshot();
  assert.equal(restoredDoc.setupRevision, 1);
  assert.deepEqual(restoredDoc.players[0].ops, ops);
  await match.dispose();
  await restored.dispose();
});

test('session and room metadata retain potential/development and AI-last across persistence', () => {
  const registry = new SessionRegistry();
  const session = registry.create('Merge');
  session.ops = ops;
  const lobby = new Lobby({ registry, getData: () => DATA, log: quiet });
  try {
    assert.deepEqual(lobby.create(session, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
    const room = lobby.roomOf(session);
    room.aiPicksLast = true;
    const saved = sessionDoc(session, Date.now());
    const otherRegistry = new SessionRegistry();
    const adopted = otherRegistry.adopt(saved);
    assert.deepEqual(adopted.ops, ops);
    const other = new Lobby({ registry: otherRegistry, getData: () => DATA, log: quiet });
    try {
      other.restoreRooms([roomDoc(room)]);
      const restored = other.roomOf(adopted);
      assert.equal(restored.aiPicksLast, true);
      assert.deepEqual(restored.seatOf(adopted.playerId).ops, ops);
    } finally { other.shutdown(); }
  } finally { lobby.shutdown(); }
});
