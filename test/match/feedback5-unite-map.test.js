// GitHub #41 (item 3): the 联防 field was the round's own stage — its water, crates and devices included — opened to both
// halves. Official: act2autochess constData escapedBattleTemplateMapSinglePlayer / MultiPlayer = level_act1autochess_
// escaped_single / _multi, the level of the 联防 battle and its map (two road halves joined at col 10). One helper →
// escaped_single (enemies enter at col 10), two helpers → escaped_multi (enemies enter at col 18 and pass (9,10)); the
// helpers' pieces stand on their prep tiles ("按休整期位置部署在场"), the first of two shifted 8 columns onto the right half
// ("率先迎敌(即位于右侧阵地)"). data/stages.json holds both maps (kind 'unite'); server/match/unite.js uniteStageId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEO, PHASE } from '../../shared/constants.js';
import { Battle } from '../../server/sim/Battle.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { uniteStageId } from '../../server/match/unite.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch, give, chessOfTier, legalTileFor, checkInvariants } from './harness.js';

/** A real battle that only ends by its time limit (the check follows the enemies, whatever the helpers do). */
class NoFinish extends Battle {
  constructor(o) { super({ ...o, autoFinish: false }); }
}

/**
 * Co-op on 战场#01 (its row 9 is fenced off at cols 5–7: "##Err###rrSrr###rrS##"): p_0 leaks 3 enemies, the other
 * players are perfect — 1 helper with 2 humans, 2 helpers with 3. Each helper fields one ranged operator in its corner.
 */
function scenario({ humans, clientCombat }) {
  const h = makeMatch({
    mode: 'coop', humans, seed: 4101 + humans, fake: true, clientCombat,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 3 } } : {}),
  }).start();
  const m = h.m;
  h.toPrep(1);
  h.setStage('act1autochess_m01');
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  const helpers = [];
  for (let i = 1; i < humans; i++) {
    const ps = h.ps(`p_${i}`);
    const id = ranged[i];
    helpers.push({ ps, piece: give(m, ps, id, 'board', legalTileFor(m, ps, id)) });
  }
  h.drive(() => m.phase === PHASE.UNITE);
  return { h, m, helpers };
}

/** The 联防 field's spec / options as the match built them, and a real battle over them. */
function uniteField(m, clientCombat) {
  if (clientCombat) {
    const f = m.fields[0];
    return { opts: f.spec, battle: createBattleFromSpec(f.spec, new DataSource(DATA, null), { BattleClass: NoFinish, recordEvents: false }) };
  }
  const u = FakeBattle.instances.find((b) => b.kind === 'unite');
  return { opts: u.opts, battle: new NoFinish({ ...u.opts, data: m.ds, logger: { warn() {}, error() {}, info() {}, debug() {} } }) };
}

for (const clientCombat of [true, false]) {
  test(`联防 with 1 helper (${clientCombat ? 'client-side combat' : 'server-run'}): escaped_single, not the round's stage — enemies enter at col 10 and walk row 9`, () => {
    const { m, helpers } = scenario({ humans: 2, clientCombat });
    assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId), ['p_1']);
    const { opts, battle: b } = uniteField(m, clientCombat);
    assert.equal(opts.stageId, 'act1autochess_escaped_single');
    assert.equal(uniteStageId(m.gd, 1), 'act1autochess_escaped_single');
    assert.deepEqual(opts.rect, GEO.UNITE_RECT, 'the whole 19×21 map\'s field rows (both halves are road on it)');
    assert.equal(b.stage.id, 'act1autochess_escaped_single');
    assert.deepEqual(b.stage.devices, [], 'no crates or devices of 战场#01');
    // the map: row 9 is road from the gate (9,10) to the objective (9,2); on 战场#01 cols 5–7 are fenced off
    for (let c = 3; c <= 9; c++) assert.ok(b.grid.groundPassable(9, c), `(9,${c}) is road`);
    assert.equal(m.stage.rows[9].slice(5, 8), '###', '战场#01 itself has no ground there');
    for (const c of [19, 20]) assert.ok(!b.grid.groundPassable(9, c), `(9,${c}) is no ground`);
    // the routes of escaped_single: every one starts at col 10
    assert.ok(opts.routes.every((r) => (r.start ?? [r.startPosition?.row, r.startPosition?.col])[1] === 10));
    // the helper's piece stands on its prep tile
    const { ps, piece } = helpers[0];
    const [r, c] = [...ps.board.entries()].find(([, p]) => p === piece)[0].split(',').map(Number);
    b.step();
    const u = b.allyUnits.find((x) => x.uid === piece.uid && x.ownerId === 'p_1');
    assert.deepEqual([u.tileR, u.tileC], [r, c]);
    // a walker crosses the tiles 战场#01 fences off
    const crossed = new Set();
    while (b.time < 60 && !b.finished) {
      b.step();
      for (const e of b.enemies) if (e.alive && e.motion !== 'FLY') crossed.add(`${Math.round(e.y)},${Math.round(e.x)}`);
    }
    assert.ok(['9,5', '9,6', '9,7'].some((k) => crossed.has(k)), `a walker on row 9 cols 5–7 (${[...crossed].sort().join(' ')})`);
    assert.equal(b.errorCount || 0, 0);
    checkInvariants(m);
    m.dispose();
  });
}

test('联防 with 2 helpers: escaped_multi — the first helper on the right half (col + 8), enemies enter at col 18 through (9,10); the client draws the field\'s map', () => {
  const { h, m, helpers } = scenario({ humans: 3, clientCombat: false });
  const order = m.unitePlan.helpers.map((p) => p.playerId);
  assert.equal(order.length, 2);
  const { opts, battle: b } = uniteField(m, false);
  assert.equal(opts.stageId, 'act1autochess_escaped_multi');
  assert.equal(b.stage.id, 'act1autochess_escaped_multi');
  assert.deepEqual(opts.players.map((p) => [p.playerId, p.colOffset]), [[order[0], 8], [order[1], 0]]);
  assert.ok(opts.routes.every((r) => r.start[1] === 18), 'every route enters at col 18');
  assert.ok(opts.routes.filter((r) => r.motion === 'WALK').every((r) => r.checkpoints.some(([rr, cc]) => rr === 9 && cc === 10)), 'walkers pass (9,10)');
  b.step();
  for (const { ps, piece } of helpers) {
    const [r, c] = [...ps.board.entries()].find(([, p]) => p === piece)[0].split(',').map(Number);
    const u = b.allyUnits.find((x) => x.uid === piece.uid && x.ownerId === ps.playerId);
    const off = ps.playerId === order[0] ? 8 : 0;
    assert.deepEqual([u.tileR, u.tileC], [r, c + off], `${ps.playerId}: its prep tile${off ? ' on the right half' : ''}`);
    assert.equal(b.stage.rows[r][c + off], 'r', 'a road tile of the 联防 map');
  }
  // what a watching browser receives: the m.field of the 联防 carries the map it is drawn on
  m.handle('p_0', { t: 'g.watch', fieldId: 'u' });
  const meta = h.lastTo('p_0', 'm.field');
  assert.equal(meta && meta.stageId, 'act1autochess_escaped_multi');
  assert.equal(m.stageId, 'act1autochess_m01', 'the match stage (m.public stageId, the boards) stays the round\'s');
  checkInvariants(m);
  m.dispose();
});

test('degraded data without the 联防 maps: the field keeps the round\'s stage', () => {
  const stages = Object.fromEntries(Object.entries(DATA.stages).filter(([, s]) => s.kind !== 'unite'));
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 4199, fake: true, data: { ...DATA, stages }, script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 2 } } : {}) }).start();
  const m = h.m;
  h.toPrep(1);
  assert.equal(uniteStageId(m.gd, 1), null);
  const ps = h.ps('p_1');
  const id = chessOfTier(1, (c) => c.position === 'RANGED').find((x) => m.pool.has(x));
  give(m, ps, id, 'board', legalTileFor(m, ps, id));
  h.drive(() => m.phase === PHASE.UNITE);
  assert.equal(FakeBattle.instances.find((b) => b.kind === 'unite').opts.stageId, m.stageId);
  m.dispose();
});
