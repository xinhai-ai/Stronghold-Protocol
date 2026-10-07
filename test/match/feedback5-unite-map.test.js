// GitHub #282: the flat escape template erased the helpers' terrain and blocking devices. Keep the round stage;
// escaped_single / _multi supply the 联防 enemy batches and routes (two halves joined at col 10). One helper →
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
import { buildUniteWave } from '../../server/match/waves.js';
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
function scenario({ humans, clientCombat, stageId = 'act1autochess_m01', configureHelper = () => {} }) {
  const h = makeMatch({
    mode: 'coop', humans, seed: 4101 + humans, fake: true, clientCombat,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 3 } } : {}),
  }).start();
  const m = h.m;
  h.toPrep(1);
  h.setStage(stageId);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  const helpers = [];
  for (let i = 1; i < humans; i++) {
    const ps = h.ps(`p_${i}`);
    const id = ranged[i];
    helpers.push({ ps, piece: give(m, ps, id, 'board', legalTileFor(m, ps, id)) });
    configureHelper(ps, i);
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
  for (const stageId of ['act1autochess_m01', 'act2autochess_m02']) {
    test(`#282: 联防 keeps ${stageId}'s terrain and blocking devices (${clientCombat ? 'client' : 'server'})`, () => {
      const { m } = scenario({ humans: 2, clientCombat, stageId });
      try {
        const { opts, battle: b } = uniteField(m, clientCombat);
        assert.equal(opts.stageId, stageId, 'the escape wave must not replace the helper battlefield');
        assert.deepEqual(b.stage.rows, m.stage.rows);
        b.step();
        const blocking = DATA.stages[stageId].devices.filter((d) => d.active && ['crate', 'platform'].includes(d.role)
          && d.pos[0] >= 9 && d.pos[0] <= 12 && d.pos[1] <= 10);
        assert.ok(blocking.length, 'the reported map has blocking devices');
        for (const d of blocking) {
          assert.equal(b.grid.groundPassable(...d.pos), false, `${d.alias}: still blocks the battlefield`);
        }
      } finally {
        m.dispose();
      }
    });
  }
}

for (const clientCombat of [true, false]) {
  test(`#282: helpers retain their own crate-removal effects (${clientCombat ? 'client' : 'server'})`, () => {
    const { m } = scenario({ humans: 3, clientCombat, configureHelper(ps, i) {
      if (i !== 1) return;
      for (const d of DATA.stages.act1autochess_m01.devices) if (d.role === 'crate') ps.deviceOverrides[d.alias] = false;
    } });
    try {
      const { opts, battle: b } = uniteField(m, clientCombat);
      assert.deepEqual(opts.players.map((p) => [p.playerId, p.colOffset]), [['p_1', 8], ['p_2', 0]]);
      b.step();
      const crates = b.allyUnits.filter((u) => u.kind === 'device' && u.defId === 'trap_1105_accrate' && u.alive);
      assert.ok(crates.some((u) => u.x < 10), 'the left helper keeps its crates');
      assert.equal(crates.some((u) => u.x > 10), false, 'only the right helper removed its crates');
      assert.equal(b.grid.obstacle[10 * 21 + 13], 0, 'removed right-hand crate leaves no device obstacle');
      assert.notEqual(b.grid.obstacle[10 * 21 + 5], 0, 'left-hand crate is still blocking');
    } finally {
      m.dispose();
    }
  });
}

test('#282: browser and server simulate the same obstacle-preserving two-helper field', () => {
  const { m } = scenario({ humans: 3, clientCombat: true, stageId: 'act2autochess_m02' });
  try {
    const spec = m.fields[0].spec;
    const local = createBattleFromSpec(JSON.parse(JSON.stringify(spec)), new DataSource(DATA, null), { quiet: true });
    const server = createBattleFromSpec(spec, m.ds, { quiet: true });
    const localResult = local.runToEnd(1000);
    const serverResult = server.runToEnd(1000);
    assert.deepEqual(localResult, serverResult);
    assert.equal(local.errorCount, 0);
    assert.equal(server.errorCount, 0);
  } finally {
    m.dispose();
  }
});

for (const clientCombat of [true, false]) {
  test(`联防 with 1 helper (${clientCombat ? 'client-side combat' : 'server-run'}): escape routes navigate the round's obstacles`, () => {
    const { m, helpers } = scenario({ humans: 2, clientCombat });
    assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId), ['p_1']);
    const { opts, battle: b } = uniteField(m, clientCombat);
    assert.equal(opts.stageId, m.stageId);
    assert.equal(uniteStageId(m.gd, 1, m.stageId), m.stageId);
    assert.deepEqual(opts.rect, GEO.UNITE_RECT, 'the whole 19×21 map\'s field rows (both halves are road on it)');
    assert.equal(b.stage.id, m.stageId);
    assert.ok(b.stage.devices.some((d) => d.role === 'crate'), 'the battlefield crates remain');
    for (let c = 5; c <= 7; c++) assert.equal(b.grid.groundPassable(9, c), false, `(9,${c}) remains impassable`);
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
    // Walkers detour instead of crossing the missing terrain from the flat template.
    const path = b.grid.findPath(9, 10, 9, 2);
    assert.ok(path && path.some(([r]) => r === 12), 'a route around the fences exists');
    const crossed = new Set();
    while (b.time < 60 && !b.finished) {
      b.step();
      for (const e of b.enemies) if (e.alive && e.motion !== 'FLY') crossed.add(`${Math.round(e.y)},${Math.round(e.x)}`);
    }
    assert.ok(!['9,5', '9,6', '9,7'].some((k) => crossed.has(k)), 'walkers do not cross forbidden tiles');
    assert.equal(b.errorCount || 0, 0);
    checkInvariants(m);
    m.dispose();
  });
}

test('联防 with 2 helpers: original terrain on both halves, escape routes and helper placement retained', () => {
  const { h, m, helpers } = scenario({ humans: 3, clientCombat: false });
  const order = m.unitePlan.helpers.map((p) => p.playerId);
  assert.equal(order.length, 2);
  const { opts, battle: b } = uniteField(m, false);
  assert.equal(opts.stageId, m.stageId);
  assert.equal(b.stage.id, m.stageId);
  assert.deepEqual(b.stage.rows, m.stage.rows);
  assert.deepEqual(opts.players.map((p) => [p.playerId, p.colOffset]), [[order[0], 8], [order[1], 0]]);
  assert.ok(opts.routes.every((r) => r.start[1] === 18), 'every route enters at col 18');
  assert.ok(opts.routes.filter((r) => r.motion === 'WALK').every((r) => r.checkpoints.some(([rr, cc]) => rr === 9 && cc === 10)), 'walkers pass (9,10)');
  b.step();
  for (const { ps, piece } of helpers) {
    const [r, c] = [...ps.board.entries()].find(([, p]) => p === piece)[0].split(',').map(Number);
    const u = b.allyUnits.find((x) => x.uid === piece.uid && x.ownerId === ps.playerId);
    const off = ps.playerId === order[0] ? 8 : 0;
    assert.deepEqual([u.tileR, u.tileC], [r, c + off], `${ps.playerId}: its prep tile${off ? ' on the right half' : ''}`);
    assert.equal(b.stage.rows[r][c + off], m.stage.rows[r][c], 'the helper keeps the original tile');
  }
  // what a watching browser receives: the m.field of the 联防 carries the map it is drawn on
  m.handle('p_0', { t: 'g.watch', fieldId: 'u' });
  const meta = h.lastTo('p_0', 'm.field');
  assert.equal(meta && meta.stageId, m.stageId);
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

test('#282: escape walking routes remain reachable on every current stage with blocking devices', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true });
  try {
    const stages = Object.values(DATA.stages).filter((s) => s.kind !== 'unite' && s.active);
    assert.ok(stages.length >= 7, 'current battlefields are covered');
    for (const st of stages) {
      for (const count of [1, 2]) {
        const wave = buildUniteWave(h.m.gd, [], count, 60);
        assert.ok(wave.routes.some((r) => r.motion === 'WALK'), 'the actual escape walking routes are checked');
        const b = new NoFinish({ stageId: st.stageId || st.id, kind: 'unite', rect: GEO.UNITE_RECT,
          data: new DataSource(DATA, null), players: [], routes: wave.routes, recordEvents: false, quiet: true });
        b.step();
        for (const route of wave.routes.filter((r) => r.motion === 'WALK')) {
          const points = [route.start, ...(route.checkpoints || []), route.end];
          for (let i = 1; i < points.length; i++) {
            assert.ok(b.grid.findPath(...points[i - 1], ...points[i]), `${st.id}, ${count} helpers: leg ${i} is reachable`);
          }
        }
      }
    }
  } finally {
    h.m.dispose();
  }
});

test('#282: missing round-stage data uses the available escape map as a fallback', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true });
  try {
    assert.equal(uniteStageId(h.m.gd, 1, 'missing-stage'), 'act1autochess_escaped_single');
    assert.equal(uniteStageId(h.m.gd, 2, 'missing-stage'), 'act1autochess_escaped_multi');
  } finally {
    h.m.dispose();
  }
});
