// test/sim/feedback5-raid-own-board.test.js — 突袭 lands only on its player's own board (community reports of
// 2026-10-06, items 40 and 16.3; DESIGN §25.18):
//   「…新约能天使在开了突袭之后蹦到了下方原本用来临时放置溢出的干员和道具的那一栏高台的最左侧位置」 — on a boss field the
//     battle rect (BOSS_RECT rows 0–5) holds the hand row (0) and the 临时整备区 row (1), high ground buildable ALL, so a
//     ranged member could land there;
//   「单人联防时突袭也可以跑到对面的场地上」 — on the 联防 map of one helper (escaped_single) the right half (cols 11–18)
//     is in the rect but is nobody's board.
// raidTile now takes only tiles of Battle.onOwnBoard: the board region (rows 9–12, cols 2–10) mapped onto the field.
// Run: node --test test/sim/feedback5-raid-own-board.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';

const ID = 'chess_char_6_13_a'; // 新约能天使 (RANGED), given the 突袭 bond as the 转职球 / 突袭手雷 would
const raw = getDefaultSource().rawChess(ID);
const raider = { ...raw, bonds: [...raw.bonds, 'raidShip'] };
const BONDS = { raidShip: { count: 2, active: true, tier: 1, layers: 0 } };
const dummy = enemyRec({ key: 'dummy', hp: 1e9, speed: 0, mass: 0 });
const defs = { enemies: { dummy }, chess: { [ID]: raider } };

function jump({ kind, stageId, players, enemyPos, seconds = 11 }) {
  const h = makeBattle({ kind, stageId, autoFinish: false, timeLimit: 60, defs, players });
  h.step();
  const mine = h.b.allyUnits.filter((u) => u.defId === ID);
  const homes = mine.map((u) => [u.tileR, u.tileC]);
  h.spawn('dummy', { pos: enemyPos });
  h.run(seconds);
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  return { h, mine, homes };
}
const seat = (playerId, s, o = {}) => ({ playerId, seat: s, side: o.side ?? 'L', colOffset: o.colOffset ?? 0, bonds: BONDS, units: o.units ?? [] });
const unitAt = (row, col, uid = 1) => ({ uid, kind: 'chess', chessId: ID, row, col });

test('boss field (solo 最终攻势): a ranged 突袭 member never lands on the hand row 0 or the 临时整备区 row 1', () => {
  // 战场#01: the enemy on the telin (1,3); before the fix the member landed on the hand tile (0,3)
  const { h, mine } = jump({ kind: 'boss', stageId: 'act1autochess_m01', players: [seat('p1', 0, { units: [unitAt(12, 3)] })], enemyPos: [1, 3] });
  const u = mine[0];
  assert.deepEqual([u.tileR, u.tileC], [2, 3], 'the board tile next to it, not (0,3)');
  assert.ok(h.b.onOwnBoard(u.player, u.tileR, u.tileC));
  // every row-0 / row-1 tile is off the board, every board tile (rows 2–5, cols 2–10) is on it
  for (let c = 0; c <= 20; c++) for (const r of [0, 1]) assert.equal(h.b.onOwnBoard(u.player, r, c), false, `(${r},${c})`);
  for (let r = 2; r <= 5; r++) for (let c = 2; c <= 10; c++) assert.equal(h.b.onOwnBoard(u.player, r, c), true, `(${r},${c})`);
  for (let r = 2; r <= 5; r++) for (let c = 11; c <= 20; c++) assert.equal(h.b.onOwnBoard(u.player, r, c), false, `(${r},${c}) is the right half`);
  // an enemy only the temp row could reach: it stays home and does not hop
  const far = jump({ kind: 'boss', stageId: 'act1autochess_m01', players: [seat('p1', 0, { units: [unitAt(12, 3)] })], enemyPos: [0, 9] });
  assert.deepEqual([far.mine[0].tileR, far.mine[0].tileC], far.homes[0]);
});

test('boss field pair: the mirrored right player lands on its own half only', () => {
  const { h, mine } = jump({
    kind: 'boss', stageId: 'act1autochess_m01',
    players: [seat('p1', 0), seat('p2', 1, { side: 'R', units: [unitAt(12, 3)] })], enemyPos: [3, 9],
  });
  const u = mine[0];
  assert.equal(u.ownerId, 'p2');
  // the enemy stands on the partner's half next to the middle: the member takes a tile of its own half that reaches it
  // (before the fix: (2,9), the partner's road)
  assert.ok(u.tileR >= 2 && u.tileC >= 10, `landed on (${u.tileR},${u.tileC})`);
  assert.ok(h.b.onOwnBoard(u.player, u.tileR, u.tileC));
  assert.equal(h.b.onOwnBoard(u.player, 3, 5), false, 'the left half is the partner\'s');
  assert.equal(h.b.onOwnBoard(u.player, 3, 15), true);
});

test('联防 with one helper (escaped_single): 突袭 does not jump onto the right half', () => {
  for (const pos of [[10, 15], [11, 17], [9, 12]]) {
    const { h, mine, homes } = jump({ kind: 'unite', stageId: 'act1autochess_escaped_single', players: [seat('H', 0, { units: [unitAt(12, 9)] })], enemyPos: pos });
    const u = mine[0];
    assert.ok(u.tileC <= 10, `enemy ${pos}: landed on (${u.tileR},${u.tileC})`);
    assert.ok(h.b.onOwnBoard(u.player, u.tileR, u.tileC), `enemy ${pos}`);
    if (pos[1] >= 13) assert.deepEqual([u.tileR, u.tileC], homes[0], `enemy ${pos}: out of reach from the left half, it stays`);
  }
  // an enemy the left half can reach: it still jumps (onto the left half)
  const { mine } = jump({ kind: 'unite', stageId: 'act1autochess_escaped_single', players: [seat('H', 0, { units: [unitAt(12, 3)] })], enemyPos: [9, 9] });
  assert.ok(mine[0].tileC <= 10 && mine[0].tileC >= 7, `landed on (${mine[0].tileR},${mine[0].tileC})`);
});

test('联防 with two helpers (escaped_multi): each helper lands on its own half', () => {
  const players = [seat('L', 0, { units: [unitAt(12, 3, 1)] }), seat('R', 1, { colOffset: 8, units: [unitAt(12, 9, 2)] })];
  const { h, mine } = jump({ kind: 'unite', stageId: 'act1autochess_escaped_multi', players, enemyPos: [10, 15] });
  const right = mine.find((u) => u.ownerId === 'R'), left = mine.find((u) => u.ownerId === 'L');
  assert.ok(right.tileC >= 11, `the right helper lands on its half: (${right.tileR},${right.tileC})`);
  assert.ok(h.b.onOwnBoard(right.player, right.tileR, right.tileC));
  assert.ok(left.tileC <= 10, `the left helper stays on its half: (${left.tileR},${left.tileC})`);
});
