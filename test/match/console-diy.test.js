import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../../shared/constants.js';
import { makeMatch, checkInvariants, DATA } from './harness.js';

const SLOT = 'chess_char_5_diy1_a';
const ELITE = 'chess_char_5_diy1_b';
const OTHER = 'chess_char_5_diy2_a';
const PICK = { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' };

function prep(t) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', fake: true, consoleEnabled: true,
    seats: [
      { seat: 0, playerId: 'p_0', name: 'A', isBot: false, connected: true, diy: { [SLOT]: PICK } },
      { seat: 1, playerId: 'p_1', name: 'B', isBot: false, connected: true, diy: { [OTHER]: PICK } },
    ] }).start();
  t.after(() => h.m.dispose());
  h.toPrep();
  return h;
}

test('console grants own normal and elite DIY operators with their chosen skill and module', (t) => {
  const h = prep(t), ps = h.ps('p_0');
  const shared = h.m.pool.snapshot();
  const stock = ps.diyStock.snapshot();
  for (const id of [SLOT, ELITE]) {
    assert.deepEqual(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id }), { ok: true });
    const piece = ps.allChess().find((p) => p.id === id);
    assert.ok(piece);
    assert.equal(piece.poolCopies, 0);
    assert.deepEqual(ps.diyPickOf(id), ps.diy[SLOT]);
    assert.equal(ps.gd.chess(id).charId, PICK.charId);
    assert.match(h.lastBc('m.ticker').text, /\u63a8\u8fdb\u4e4b\u738b/);
  }
  assert.deepEqual(h.m.pool.snapshot(), shared);
  assert.deepEqual(ps.diyStock.snapshot(), stock);
  assert.equal(ps.consoleRoundUses, 2);
  checkInvariants(h.m);
});

test('three console DIY copies merge normally and selling never creates private stock', (t) => {
  const h = prep(t), ps = h.ps('p_0');
  const stock = ps.diyStock.snapshot();
  for (let i = 0; i < 3; i++) assert.deepEqual(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id: SLOT }), { ok: true });
  const owned = ps.allChess().filter((p) => ps.gd.baseIdOf(p.id) === SLOT);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].id, ELITE);
  assert.equal(owned[0].poolCopies, 0);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.sell', uid: owned[0].uid }), { ok: true });
  assert.deepEqual(ps.diyStock.snapshot(), stock);
  checkInvariants(h.m);
});

test('unfilled or teammate-only DIY slots and hidden operators remain invalid without consuming quota', (t) => {
  const h = prep(t), ps = h.ps('p_0');
  const hidden = Object.keys(DATA.chess).find((id) => DATA.chess[id].isHidden);
  for (const id of [OTHER, 'chess_char_6_diy1_a', hidden, '__proto__']) {
    assert.equal(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id }).error, ERR.BAD_TARGET);
  }
  assert.equal(ps.consoleRoundUses, 0);
  assert.equal(ps.consoleTotalUses, 0);
  h.m.consoleEnabled = false;
  assert.equal(h.m.handle('p_0', { t: 'g.console', kind: 'chess', id: SLOT }).error, ERR.BAD_MSG);
});
