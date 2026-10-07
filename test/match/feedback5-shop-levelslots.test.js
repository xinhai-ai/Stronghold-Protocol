// Community report of 2026-10-06, item 19: 「升级商店获得新的商店位时用新卡补上，而不是空着」. The official tutorial's 休整期
// page says 「升级：消耗资金升级调度中心。升级后将出现更多的商品栏位、可调度干员以及新装备」: the upgrade itself opens the
// new level's extra slot. Until 0.2.0 the shop kept its old slot count until the next roll (a refresh or the round start),
// so a level-up from 1 to 2 (险境: 3 → 4 operator slots) or 3 to 4 (4 → 5) showed no new card. Now the upgrade adds the
// extra slots at once, each with a new card drawn at the new level, and leaves the cards already shown where they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';

const ids = (slots) => slots.map((s) => (s ? `${s.kind}:${s.id}${s.sold ? '(sold)' : ''}` : null));
const tierOf = (id) => DATA.chess[id]?.tier ?? 0;

test('a level-up opens the new level\'s operator slot at once with a new card; the cards shown stay in place', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 7, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  assert.deepEqual(h.m.gd.shopSlots(1), { chess: 3, item: 1 });
  const s1 = ps.shop.slots.slice();
  assert.equal(s1.length, 4);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true });
  // level 2: 4 operator slots + the item slot — the three cards and the item kept (the same objects), one new card
  assert.equal(ps.shop.level, 2);
  assert.deepEqual(ps.shop.layout, { chess: 4, item: 1 });
  assert.equal(ps.shop.slots.length, 5);
  for (let i = 0; i < 3; i++) assert.equal(ps.shop.slots[i], s1[i], `operator card ${i} kept`);
  assert.equal(ps.shop.slots[4], s1[3], 'the item card stays after the operator cards');
  const added = ps.shop.slots[3];
  assert.ok(added && added.kind === 'chess' && !added.sold, `a new operator card: ${JSON.stringify(added)}`);
  assert.ok(tierOf(added.id) >= 1 && tierOf(added.id) <= 2, `drawn at the new level (tier ${tierOf(added.id)})`);
  assert.equal(added.frozen, false);
  // the player sees it right away (m.private shop)
  assert.deepEqual(ids(ps.privateView().shop.slots), ids(ps.shop.slots));
  // 2 → 3 keeps 4 operator slots: nothing rerolled
  const s2 = ps.shop.slots.slice();
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.level, 3);
  assert.deepEqual(ps.shop.slots, s2, 'no extra slot at level 3, no reroll');
  // 3 → 4: the fifth operator slot
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.level, 4);
  assert.deepEqual(ps.shop.layout, { chess: 5, item: 1 });
  for (let i = 0; i < 4; i++) assert.equal(ps.shop.slots[i], s2[i]);
  assert.equal(ps.shop.slots[5], s2[4]);
  assert.ok(ps.shop.slots[4]?.kind === 'chess' && tierOf(ps.shop.slots[4].id) <= 4);
  h.invariants();
  h.m.dispose();
});

test('a bought card stays sold; a frozen shop freezes the new card too [ASSUMED], and the round start keeps it', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  assert.deepEqual(h.m.handle('p_0', { t: 'g.buy', slot: 0 }), { ok: true });
  assert.equal(ps.shop.slots[0].sold, true);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.freeze' }), { ok: true });
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.slots[0].sold, true, 'the bought slot is not refilled');
  const added = ps.shop.slots[3];
  assert.ok(added && !added.sold && added.frozen === true, 'the new card follows the freeze toggle');
  const keep = ps.shop.slots.filter((s) => s && !s.sold && s.frozen).map((s) => s.id);
  assert.equal(keep.length, 4, 'two operator cards, the new one and the item');
  // the next round start keeps every frozen card (in place) and rolls only the sold slot
  h.drive(() => h.m.phase === 'PREP' && h.m.round === 2);
  assert.deepEqual(ps.shop.slots.slice(1).map((s) => s.id), keep);
  assert.equal(ps.shop.slots.length, 5);
  h.invariants();
  h.m.dispose();
});

test('every mode\'s slot table: a level-up adds exactly the slots the new level has more of (标准: 3,4,4,4,4,5)', () => {
  for (const [mode, difficulty] of [['solo', 'FUNNY'], ['solo', 'NORMAL'], ['coop', 'FUNNY'], ['coop', 'ABYSS']]) {
    const h = makeMatch({ mode, difficulty, seed: 3, fake: true, humans: 1, bots: mode === 'coop' ? 1 : 0 }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    const gd = h.m.gd;
    ps.funds = 500;
    for (let lv = 2; lv <= gd.maxShopLevel; lv++) {
      const before = ps.shop.slots.slice();
      assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true });
      const { chess, item } = gd.shopSlots(lv);
      assert.equal(ps.shop.slots.length, chess + item, `${mode} ${difficulty} L${lv}`);
      const grew = chess - gd.shopSlots(lv - 1).chess;
      const kept = ps.shop.slots.filter((s) => before.includes(s)).length;
      assert.equal(kept, before.length, `${mode} ${difficulty} L${lv}: every shown card kept`);
      assert.equal(ps.shop.slots.length - before.length, grew + (item - gd.shopSlots(lv - 1).item));
    }
    h.invariants();
    h.m.dispose();
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((l) => new GameData(DATA, 'mode_single_funny').shopSlots(l).chess), [3, 4, 4, 4, 4, 5]);
});
