// Mode lists keep chess-pool bans but never disable bond activation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { computeBonds, bondList, bondSnapshot, offBondCounts } from '../../server/match/bondsMeta.js';
import { DATA } from './harness.js';

const funny = new GameData(DATA, 'mode_single_funny');
const open = new GameData(DATA, 'mode_multi_normal');
let uid = 1;
const piece = (id) => ({ uid: uid++, kind: 'chess', id, items: [] });
const state = ({ board = [], hand = [], layers = {}, bondCountBonus } = {}) => {
  const b = new Map();
  board.forEach((p, i) => b.set(`${9 + (i % 4)},${2 + Math.floor(i / 4)}`, p));
  const h = new Array(10).fill(null);
  hand.forEach((p, i) => { h[9 - i] = p; });
  return { board: b, hand: h, layers, bondCountBonus };
};
const members = (bond, n) => Object.values(DATA.chess)
  .filter((c) => c.visible && !c.isGolden && c.bonds.includes(bond))
  .slice(0, n)
  .map((c) => c.chessId);

const INVESTOR = members('investShip', 3);
const RAIDER = members('raidShip', 1);
const YAN = members('yanShip', 1);

test('标准模拟: mode-banned 投资人 and 突袭 can activate and enter the battle snapshot', () => {
  assert.equal(funny.modeInactiveBonds.has('investShip'), true, 'pool ban list is retained');
  const ps = state({ board: [piece(RAIDER[0]), piece(YAN[0])], hand: INVESTOR.map(piece),
    layers: { investShip: 12, raidShip: 4 }, bondCountBonus: { raidShip: 1 } });
  const bonds = computeBonds(funny, ps);
  assert.equal(bonds.investShip.count, 3);
  assert.equal(bonds.investShip.active, true);
  assert.equal(bonds.raidShip.active, true);
  assert.equal(bondSnapshot(bonds).investShip.active, true);
  assert.equal(bondSnapshot(bonds).raidShip.active, true);
  assert.equal(offBondCounts(funny, ps), null);
  const list = bondList(funny, bonds, { full: true });
  assert.equal(list.some((b) => b.off), false);
  assert.equal(list.find((b) => b.bondId === 'investShip').countsHand, true);
});

test('BOARD_AND_DECK still counts distinct hand members, excluding temporary slots', () => {
  const [a, b] = INVESTOR;
  assert.equal(computeBonds(funny, state({ hand: [piece(a), piece(b)] })).investShip.count, 2);
  assert.equal(computeBonds(funny, state({ board: [piece(a)], hand: [piece(a), piece(DATA.chess[a].goldenId)] })).investShip.count, 1);
  assert.equal(computeBonds(funny, { ...state(), temp: [piece(a)] }).investShip.count, 0);
  assert.equal(computeBonds(funny, state({ hand: [piece(RAIDER[0])] })).raidShip.count, 0);
});

test('modes without pool bans keep the same bond counts', () => {
  const ps = state({ board: [piece(RAIDER[0])], hand: [piece(INVESTOR[0])] });
  assert.deepEqual(computeBonds(funny, ps), computeBonds(open, ps));
});

test('标准模拟: equipment grants can activate a core bond on the mode pool-ban list', () => {
  const board = members('yanShip', 3).map((id) => ({ ...piece(id),
    items: [{ id: 'chess_item_6_09_e_a' }, { id: 'chess_item_4_08_e_a' }] }));
  const bonds = computeBonds(funny, state({ board, layers: { lateranoShip: 25 } }));
  assert.equal(funny.modeInactiveBonds.has('lateranoShip'), true);
  assert.equal(bonds.lateranoShip.count, 3);
  assert.equal(bonds.lateranoShip.active, true);
  assert.equal(bondSnapshot(bonds).lateranoShip.layers, 25);
});
