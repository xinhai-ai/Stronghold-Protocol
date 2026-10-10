// test/match/snapshot.test.js — match checkpoints (server/match/snapshot.js): a checkpoint restores the match
// losslessly, and a restored match keeps playing *identically* to the one it replaced (same RNG positions, same pool,
// same boards) — the guarantee the Redis recovery of docs/DEPLOY.md stands on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../../shared/constants.js';
import { createRngFromState } from '../../server/sim/rng.js';
import {
  canSnapshot, snapshotMatch, restoreMatch, matchState, SNAPSHOT_VERSION, encodeState, decodeState,
} from '../../server/match/snapshot.js';
import { DATA, makeMatch, checkInvariants, legalTileFor } from './harness.js';

const DEPS = { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } };
const OPTIONS = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 42, fake: true, botSliceMs: 4 };

test('checkpoint restores stand-ins, self-selected records and their remaining private stock', () => {
  const slot = 'chess_char_5_diy1_a';
  const picks = { [slot]: { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' } };
  const seats = [{ seat: 0, playerId: 'p_0', name: 'Doctor', isBot: false,
    connected: true, notOwned: ['chess_char_4_22_a'], diy: picks }];
  const data = structuredClone(DATA);
  data.config.bans.NORMAL = { core: 0, addon: 0 };
  data.config.modes.mode_single_normal.inactiveBondIds = [];
  const a = makeMatch({ mode: 'solo', seats, data, seed: 42, fake: true }).start();
  a.toPrep(1);
  const ps = a.ps('p_0');
  assert.ok(ps.diyStock.has(slot), 'chosen operator is available for this seed');
  ps.diyStock.take(slot, 2);
  const remaining = ps.diyStock.left(slot);
  const doc = snapshotMatch(a.m);
  assert.ok(doc);
  const b = makeMatch({ mode: 'solo', seats: [{ ...seats[0], notOwned: [], diy: {} }], data, seed: 42, fake: true });
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  const restored = b.ps('p_0');
  assert.deepEqual(restored.standIns, ps.standIns);
  assert.deepEqual(restored.diy, ps.diy);
  assert.equal(restored.gd.chess(slot).charId, 'char_112_siege');
  assert.equal(restored.diyStock.left(slot), remaining);
  assert.equal(restored.diyStock.take(slot), 1, 'stock methods are rebuilt');
  assert.equal(restored.diyStock.left(slot), remaining - 1);
  a.m.dispose();
  b.m.dispose();
});

/** A driven match and a fresh instance to restore a checkpoint into. */
function pair(seed = OPTIONS.seed) {
  const opts = { ...OPTIONS, seed };
  return { a: makeMatch(opts), b: makeMatch(opts) };
}

/** One scheduling step with the same automatic human decisions the harness' drive makes (`ready: false` holds the prep). */
function step(h, { ready = true } = {}) {
  const m = h.m;
  if (m.ended || m.disposed) return false;
  for (const ps of m.players.values()) {
    if (ps.isBot || ps.left) continue;
    if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
    else if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
    else if (m.phase === PHASE.SP_DRAFT && m.spTurn() === ps.playerId) {
      const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
      if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
    } else if (ready && m.phase === PHASE.PREP && ps.alive && !ps.ready) {
      if (!ps.tempEmpty) ps.resolveTemp();
      m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
  }
  return h.sched.runNext();
}

/** Advance until `pred` holds (or the step budget runs out). @returns {boolean} */
function driveTo(h, pred, { maxSteps = 2e6, ready = true } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (pred(h.m)) return true;
    if (!step(h, { ready })) break;
  }
  return pred(h.m);
}

/** Advance both matches in lockstep until `pred` holds for both. */
function runBoth(a, b, pred, maxSteps = 2e6) {
  for (let i = 0; i < maxSteps; i++) {
    if (pred(a.m) && pred(b.m)) return true;
    step(a);
    step(b);
  }
  return pred(a.m) && pred(b.m);
}

/**
 * Normalizes what a restore deliberately changes or what the two matches legitimately disagree about:
 * - the battle-id sequence is bumped (a re-fought round may not reuse the ids of the interrupted one);
 * - every human starts disconnected (the lobby rebinds them on hello);
 * - `ready` is a client-driven flag of the same kind (a reconnecting player presses it again), and a restored match
 *   re-arms its clocks from the *remaining* time, so the two instances may sit at different points of the ready cycle
 *   even after the same number of harness steps. Everything else — boards, pool, funds, round, RNG positions — must
 *   match exactly.
 */
function norm(state, { seqGap = 0 } = {}) {
  const out = JSON.parse(JSON.stringify(state));
  out.match._battleSeq = (Number(out.match._battleSeq) || 0) - seqGap;
  for (const p of Object.values(out.players)) {
    // Cosmetic bot emotes use the local clock, which differs between the restored and original timelines.
    if (p.isBot) p.lastEmoteAt = 0;
    p.connected = true;
    p.ready = true;
  }
  return out;
}


test('a checkpoint restores the match losslessly (PREP, mid-prep actions)', () => {
  const { a, b } = pair(7);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.phase === PHASE.PREP && canSnapshot(a.m), { ready: false }), 'reached a quiet prep');
  assert.equal(a.m.phase, PHASE.PREP);
  assert.equal(a.m.round, 1);

  // play a real prep: buy the first chess on the shelf, deploy it, refresh, level up
  const human = a.m.players.get('p_0');
  assert.ok(human.funds > 0, 'income at round start');
  const slot = human.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
  assert.ok(slot >= 0, 'a chess on the shelf');
  assert.deepEqual(a.m.handle('p_0', { t: 'g.buy', slot }), { ok: true });
  const bought = [...human.hand].find(Boolean);
  assert.ok(bought, 'bought a chess');
  const [row, col] = legalTileFor(a.m, human, bought.id);
  assert.deepEqual(a.m.handle('p_0', { t: 'g.move', uid: bought.uid, to: { area: 'board', row, col } }), { ok: true });
  assert.equal(human.board.size, 1);
  a.m.handle('p_0', { t: 'g.refresh' });
  a.m.handle('p_0', { t: 'g.levelUp' });
  checkInvariants(a.m);

  const doc = snapshotMatch(a.m);
  assert.ok(doc, 'checkpoint taken');
  assert.equal(doc.v, SNAPSHOT_VERSION);
  assert.equal(doc.phase, PHASE.PREP);
  assert.equal(doc.round, 1);
  assert.ok(doc.deadlineRemainingMs > 0, 'prep clock saved as remaining time');
  assert.ok(Object.keys(doc.poolLeft).length > 0, 'pool saved');
  assert.deepEqual(doc.players.map((p) => p.playerId), a.m.order.map((p) => p.playerId));

  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.equal(b.m.phase, PHASE.PREP);
  assert.equal(b.m.round, 1);
  assert.ok(b.m.deadline > b.m.sched.now(), 'prep deadline re-armed in the future');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
  checkInvariants(b.m);
  assert.deepEqual(b.m.players.get('p_0').board.size, 1, 'restored board');

  // the restored match plays on identically: both reach the next prep with the same state
  assert.ok(runBoth(a, b, (m) => m.ended || (m.phase === PHASE.PREP && m.round === 2)), 'both reached R2');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
  assert.equal(a.m.errorCount, 0);
  assert.equal(b.m.errorCount, 0);
  checkInvariants(b.m);
});

test('a checkpoint restores the strategy draft (BAND_DRAFT) and the highlighted band', () => {
  const { a, b } = pair(11);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.phase === PHASE.BAND_DRAFT, { maxSteps: 1e4 }), 'reached the band draft');
  assert.deepEqual(a.m.handle('p_0', { t: 'g.bandFocus', bandId: 'band_bldsk' }), { ok: true });
  const doc = snapshotMatch(a.m);
  assert.ok(doc && doc.phase === PHASE.BAND_DRAFT, 'band checkpoint');
  assert.equal(doc.draft.order.length, 3);

  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.equal(b.m.phase, PHASE.BAND_DRAFT);
  assert.ok(b.m.draft.turnDeadline > b.m.sched.now(), 'turn clock re-armed');
  assert.deepEqual([...b.m.draft.focus.entries()], [...a.m.draft.focus.entries()], 'highlighted band restored');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));

  assert.ok(runBoth(a, b, (m) => m.phase === PHASE.PREP), 'both reached the prep');
  for (const id of ['p_0', 'p_1', 'ai_0']) assert.equal(b.m.players.get(id).bandId, a.m.players.get(id).bandId);
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
});

test('a checkpoint restores a 机变 (SP_DRAFT) draft with its cards and turn', () => {
  const { a, b } = pair(3);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.phase === PHASE.SP_DRAFT, { maxSteps: 1e6 }), `reached SP_DRAFT (${a.m.phase})`);
  assert.ok(a.m.sp.cards.length > 0);
  const doc = snapshotMatch(a.m);
  assert.ok(doc && doc.phase === PHASE.SP_DRAFT, 'SP checkpoint');
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.equal(b.m.phase, PHASE.SP_DRAFT);
  assert.ok(b.m.sp.turnDeadline > b.m.sched.now(), 'turn clock re-armed');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));

  assert.ok(runBoth(a, b, (m) => m.phase === PHASE.PREP && m.round >= 2, 1e6), 'both reached the next prep');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
});

test('canSnapshot refuses battles; the last safe checkpoint survives them', () => {
  const { a, b } = pair(5);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.phase === PHASE.PREP && canSnapshot(a.m), { ready: false }));
  const doc = snapshotMatch(a.m);
  assert.ok(doc);
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  // let the round end and the battle run: no new checkpoint may be taken
  assert.ok(driveTo(a, () => a.m.phase === PHASE.COMBAT || a.m.phase === PHASE.SETTLE || a.m.ended, { maxSteps: 1e5 }));
  assert.equal(canSnapshot(a.m), false, 'a battle phase is never checkpointed');
  assert.equal(snapshotMatch(a.m), null);
  // the room would restore the prep checkpoint: the round is simply fought again
  assert.equal(doc.phase, PHASE.PREP);
});

test('a checkpoint of a finished/LOBBY match is refused', () => {
  const { a } = pair(9);
  assert.equal(canSnapshot(a.m), false, 'before start()');
  assert.equal(snapshotMatch(a.m), null);
});

test('a checkpoint of a late round (items, effects, bounties) restores losslessly too', () => {
  const { a, b } = pair(23);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.round >= 4 && a.m.phase === PHASE.PREP && canSnapshot(a.m), { maxSteps: 4e6 }),
    `reached a late prep (R${a.m.round} ${a.m.phase})`);
  const doc = snapshotMatch(a.m);
  assert.ok(doc, 'late checkpoint');
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
  checkInvariants(b.m);
  // played on, the two matches stay equal for at least one more round
  assert.ok(runBoth(a, b, (m) => m.ended || (m.phase === PHASE.PREP && m.round >= doc.round + 1), 2e6), 'both played on');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
  assert.equal(b.m.errorCount, 0);
});

test('a solo match checkpoint restores (untimed prep, one human)', () => {
  const opts = { ...OPTIONS, mode: 'solo', humans: 1, bots: 0, seed: 31 };
  const a = makeMatch(opts);
  const b = makeMatch(opts);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.round >= 2 && a.m.phase === PHASE.PREP && canSnapshot(a.m), { maxSteps: 4e6 }),
    `reached a solo prep (R${a.m.round} ${a.m.phase})`);
  const doc = snapshotMatch(a.m);
  assert.ok(doc);
  assert.equal(doc.deadlineRemainingMs, 0, 'a solo prep has no clock');
  assert.equal(restoreMatch(b.m, doc, DEPS), true);
  assert.equal(b.m.deadline, 0, 'restored solo prep stays untimed');
  assert.deepEqual(norm(matchState(b.m), { seqGap: 1000 }), norm(matchState(a.m)));
});

test('the value codec keeps Maps, Sets and non-finite numbers', () => {
  const value = {
    n: -Infinity, nan: NaN, s: 'x', b: true, nil: null,
    map: new Map([[1, 'a'], ['k', ['v']]]),
    set: new Set(['a', 'b']),
    nested: { list: [1, { deep: -0 }], empty: {} },
  };
  const back = decodeState(encodeState(value));
  assert.equal(back.n, -Infinity);
  assert.ok(Number.isNaN(back.nan));
  assert.ok(back.map instanceof Map);
  assert.equal(back.map.get(1), 'a');
  assert.deepEqual(back.map.get('k'), ['v']);
  assert.ok(back.set instanceof Set);
  assert.ok(back.set.has('b'));
  assert.deepEqual(back.nested.list, [1, { deep: -0 }]);
  assert.deepEqual(back.nested.empty, {});
});

test('the value codec keeps non-enumerable properties (waves.js factions.schedule)', () => {
  const factions = ['a', 'b'];
  Object.defineProperty(factions, 'schedule', { value: { typeSlots: ['X'], picks: [null, 'p'] }, enumerable: false });
  const back = decodeState(encodeState({ factions }));
  assert.ok(Array.isArray(back.factions), 'still an array');
  assert.deepEqual(back.factions, ['a', 'b']);
  assert.deepEqual(back.factions.schedule, { typeSlots: ['X'], picks: [null, 'p'] });
  assert.equal(Object.getOwnPropertyDescriptor(back.factions, 'schedule').enumerable, false);
});

test('createRngFromState continues an RNG stream exactly (state 0 included)', () => {
  for (const start of [0, 1, 0xdeadbeef]) {
    const rng = createRngFromState(start);
    const first = [rng(), rng()];
    const again = createRngFromState(rng.state());
    assert.deepEqual([again(), again()], [rng(), rng()]);
    assert.ok(first.every((x) => Number.isFinite(x)));
  }
});

test('a checkpoint that does not fit the instance is refused instead of half-applied', () => {
  const { a, b } = pair(13);
  a.m.start();
  assert.ok(driveTo(a, () => a.m.phase === PHASE.PREP && canSnapshot(a.m), { ready: false }));
  const doc = snapshotMatch(a.m);
  assert.ok(doc);
  assert.equal(restoreMatch(b.m, doc, { ...DEPS, createRngFromState }), true);
  // a document from another version / with a seat the instance does not have
  assert.equal(restoreMatch(b.m, { ...doc, v: 99 }, DEPS), false);
  assert.equal(restoreMatch(b.m, { ...doc, players: [{ playerId: 'nope' }] }, DEPS), false);
  assert.equal(restoreMatch(b.m, { ...doc, phase: PHASE.COMBAT }, DEPS), false);
  assert.equal(restoreMatch(b.m, null, DEPS), false);
});
