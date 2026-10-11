import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, checkInvariants } from './match/harness.js';
import { snapshotMatch, restoreMatch } from '../server/match/snapshot.js';
import { createRngFromState } from '../server/sim/rng.js';
import { MatchWorkerPool } from '../server/workers/matchPool.js';
import { PHASE } from '../shared/constants.js';

const quiet = { warn() {}, error() {}, info() {}, debug() {} };
const deps = { createRngFromState, log: quiet };
const PACK = 'chess_item_5_07_e_a';
const DIY = 'chess_char_6_diy1_a';
const seats = [{ seat: 0, playerId: 'p_0', name: 'Merge', isBot: false, connected: true,
  diy: { [DIY]: { charId: 'char_112_siege', skillIndex: 1, uniEquipId: null } } }];

function overdraw(h, id) {
  const ps = h.ps('p_0'), stock = ps.poolOf(id);
  const count = stock.cap(id) + 1;
  for (let i = 0; i < count; i++) assert.ok(ps.acquireChess(id, { silent: true }));
  assert.equal(stock.entries.get(id).left, -1);
  assert.equal(stock.left(id), 0);
  checkInvariants(h.m);
}

test('0.2.4 signed shared/private copy balances survive two checkpoint restores and a return', () => {
  const options = { mode: 'solo', seats, seed: 11, fake: true };
  const first = makeMatch(options).start();
  const second = makeMatch(options);
  const third = makeMatch(options);
  try {
    const id = [...first.m.pool.entries.keys()].find(id => first.m.gd.tierOf(id) === 6);
    overdraw(first, id);
    overdraw(first, DIY);
    const doc = snapshotMatch(first.m);
    assert.equal(doc.poolLeft[id], -1);
    assert.equal(restoreMatch(second.m, doc, deps), true);
    assert.equal(second.m.pool.entries.get(id).left, -1);
    assert.equal(second.ps('p_0').diyStock.entries.get(DIY).left, -1);
    checkInvariants(second.m);
    assert.equal(restoreMatch(third.m, snapshotMatch(second.m), deps), true);
    checkInvariants(third.m);
    const ps = third.ps('p_0');
    const elite = ps.allChess().find(piece => third.m.gd.baseIdOf(piece.id) === id && third.m.gd.isGolden(piece.id));
    assert.ok(elite);
    third.m.phase = PHASE.PREP;
    assert.ok(ps.sell(elite.uid).ok);
    assert.equal(third.m.pool.left(id), 2, 'return three against a one-copy deficit, not three free copies');
    checkInvariants(third.m);
  } finally { first.m.dispose(); second.m.dispose(); third.m.dispose(); }
});

test('0.2.4 shared equipment stock is rebuilt from restored player ownership, with no extra checkpoint field', () => {
  const options = { mode: 'coop', humans: 2, seed: 11, fake: true };
  const first = makeMatch(options).start();
  const second = makeMatch(options);
  try {
    const one = first.ps('p_0').acquireItem(PACK, { silent: true });
    const two = first.ps('p_1').acquireItem(PACK, { silent: true });
    assert.ok(one && two);
    assert.equal(first.m.itemPool.left(PACK), 0);
    const doc = snapshotMatch(first.m);
    assert.equal(doc.itemPool, undefined, 'derived equipment occupancy is not separately persisted');
    assert.equal(restoreMatch(second.m, doc, deps), true);
    assert.equal(second.m.itemPool.held(PACK), 2);
    assert.equal(second.m.itemPool.left(PACK), 0);
    assert.equal(second.ps('p_0').acquireItem(PACK), null);
    second.m.phase = PHASE.PREP;
    assert.ok(second.ps('p_1').destroy(two.uid).ok);
    assert.equal(second.m.itemPool.left(PACK), 1);
    assert.ok(second.ps('p_0').acquireItem(PACK, { silent: true }));
    assert.equal(second.m.itemPool.held(PACK), 2);
    checkInvariants(second.m);
  } finally { first.m.dispose(); second.m.dispose(); }
});

test('0.2.4 Match Worker preserves signed balances and equipment ownership across a second restart', async (t) => {
  const source = makeMatch({ mode: 'solo', seats, seed: 11, fake: true }).start();
  t.after(() => source.m.dispose());
  const id = [...source.m.pool.entries.keys()].find(id => source.m.gd.tierOf(id) === 6);
  overdraw(source, id);
  overdraw(source, DIY);
  assert.ok(source.ps('p_0').acquireItem(PACK, { silent: true }));
  const initial = snapshotMatch(source.m);
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1 });
  t.after(() => pool.close());
  const options = { roomCode: 'M024', mode: 'solo', difficulty: 'NORMAL', seed: 11, matchNo: 1, seats };
  const first = await pool.create('merge024-first', options, {}, initial);
  const one = await first.snapshot();
  assert.equal(one.poolLeft[id], -1);
  const second = await pool.create('merge024-second', options, {}, one);
  const two = await second.snapshot();
  assert.equal(two.poolLeft[id], -1);
  assert.deepEqual(two.players[0].diyStock, initial.players[0].diyStock);
  assert.deepEqual(two.players[0].hand, initial.players[0].hand);
  assert.deepEqual(two.players[0].temp, initial.players[0].temp);
  await first.dispose();
  await second.dispose();
});

test('0.2.4 console merges preserve zero-reservation shared/private grants, including mixed ordinary copies', () => {
  const h = makeMatch({ mode: 'solo', seats, seed: 11, fake: true, consoleEnabled: true }).start();
  try {
    const ps = h.ps('p_0');
    const id = [...h.m.pool.entries.keys()].find(id => h.m.gd.tierOf(id) === 6);
    for (const base of [id, DIY]) {
      const pool = ps.poolOf(base), before = pool.entries.get(base).left;
      ps.consoleRoundUses = 0;
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id: base }), { ok: true });
      }
      assert.equal(pool.entries.get(base).left, before);
      const elite = ps.allChess().find(piece => ps.gd.baseIdOf(piece.id) === base && ps.gd.isGolden(piece.id));
      assert.equal(elite.poolCopies, 0);
      h.m.phase = PHASE.PREP;
      assert.ok(ps.sell(elite.uid).ok);
      assert.equal(pool.entries.get(base).left, before);
    }
    assert.ok(ps.acquireChess(id, { silent: true }));
    assert.ok(ps.acquireChess(id, { silent: true }));
    const balance = h.m.pool.entries.get(id).left;
    ps.consoleRoundUses = 0;
    assert.deepEqual(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id }), { ok: true });
    const elite = ps.allChess().find(piece => h.m.gd.baseIdOf(piece.id) === id);
    assert.equal(elite.poolCopies, 2, 'existing real copies stay reserved; the console adds none');
    assert.equal(h.m.pool.entries.get(id).left, balance);
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('0.2.4 exhausted console equipment grants return SOLD_OUT without spending quota', () => {
  const h = makeMatch({ mode: 'solo', seed: 11, fake: true, consoleEnabled: true }).start();
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual(h.m.handle('p_0', { t: 'g.console', kind: 'item', id: PACK }), { ok: true });
    const ps = h.ps('p_0');
    assert.equal(h.m.itemPool.left(PACK), 0);
    assert.equal(h.m.handle('p_0', { t: 'g.console', kind: 'item', id: PACK }).error, 'SOLD_OUT');
    assert.equal(ps.consoleRoundUses, 2);
    assert.equal(ps.consoleTotalUses, 2);
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});
