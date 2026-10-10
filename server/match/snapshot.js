// server/match/snapshot.js — checkpoints of a running match (Redis persistence, docs/DEPLOY.md「断点续玩」).
//
// WHY A CHECKPOINT AND NOT A REPLAY: the match engine is deterministic in virtual time (tests run whole matches on a
// VirtualScheduler), but a *live* match is not: bot rehearsals and server-run fields are sliced by wall-clock budgets
// (server/match/bot.js, server/match/fields.js), so the interleaving of a client frame with a sliced job depends on
// real time. Re-deriving a live match from its input journal would therefore need a fully real-time-free engine.
// Instead this module saves the match *state* — and only the state that exists while the match sits in one of the
// phases below, which is plain JSON apart from a handful of Maps and the RNG states.
//
// SAFE PHASES. A checkpoint is taken while the match is in INFO_CHECK, BAND_DRAFT, SP_DRAFT, ROUND_START or PREP.
// Those are the phases in which no battle object, no pacer and no field is alive (fields/watchers/teamLp/bossPool are
// empty), so the whole state is serializable. If a match is interrupted in COMBAT / UNITE / SETTLE / FINAL_ASSAULT /
// HIDDEN_CORE, the *last* safe checkpoint is kept: the match resumes at the start of the round it is in — its
// operators, items, economy, LP, round number and pool are exactly what they were, and the round's battle is fought
// again (a fresh battleId, see RESTORE_SEQ_GAP).
//
// ON RESTORE the clocks restart from the *remaining* time the checkpoint recorded (the match was frozen while the
// server was down), the prep gets at least MIN_RECOVER_PREP_SEC, and a draft turn that was current starts over with a
// full turn clock. A solo pause (g.pause) does not survive a restart: the restored match is running.
//
// The module is engine-side only: server/persist.js owns the storage and the lobby owns the room wiring.

import { PHASE } from '../../shared/constants.js';
import { buildNormalWave } from './waves.js';

/** Checkpoint layout version; a document of another version is refused. */
export const SNAPSHOT_VERSION = 1;

/** Phases whose state is fully serializable (see the header). */
export const SNAPSHOT_PHASES = Object.freeze([PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.ROUND_START, PHASE.PREP]);

/** A restored round's battle gets ids far above the interrupted ones (stale reports can never match a new battle). */
export const RESTORE_SEQ_GAP = 1000;

/** The prep a restored match is guaranteed to have left (s). */
export const MIN_RECOVER_PREP_SEC = 20;

/** Match.DELAYS.ROUND_START in seconds (kept local: this module must not import the engine). */
const ROUND_START_SEC = 2;

/**
 * True when a checkpoint of the match's current state may be taken (see the header). `Phase.PREP` additionally waits
 * for every AI-driven seat to finish its (sliced) prep: a snapshot in the middle of a bot's rehearsal chain would
 * capture a half-built layout that the next prep would buy again.
 * @param {import('./Match.js').Match} m
 */
export function canSnapshot(m) {
  if (!m || m.disposed || m.ended) return false;
  if (!m.sched || typeof m.sched.now !== 'function') return false;   // a stub Match (tests) has no restorable state
  if (!m.pool || !(m.pool.entries instanceof Map)) return false;
  if (!SNAPSHOT_PHASES.includes(m.phase)) return false;
  if (m.phase === PHASE.PREP) {
    for (const ps of m.alivePlayers()) if (ps.botControlled && !ps.ready) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------
// value codec (JSON + Map/Set/non-finite numbers + non-enumerable properties)
// ---------------------------------------------------------------------------------------------------
//
// The engine stores a few things JSON.stringify cannot carry: the shared pool's Maps, the draft's `focus` Map, ±Infinity
// (an untouched emote cooldown) — and `factions`, which carries the round schedule as a *non-enumerable* `schedule`
// property (waves.js setupMatchWaves: a plain array must stay an array for buildNormalWave). Dropping that property
// would silently change the waves of every later round, so the codec round-trips own data properties of objects and
// arrays whether they are enumerable or not. Accessors are never read (no side effects).

const MAP_TAG = '$spMap';
const SET_TAG = '$spSet';
const NUM_TAG = '$spNum';
const ARR_TAG = '$spArr';
const PROPS_TAG = '$spProps';

const isIndex = (k, v) => Array.isArray(v) && String(Number(k)) === k && Number(k) >= 0 && Number(k) < v.length;

/** Own *data* properties not already covered by the value itself (indices, enumerable keys). */
function extraProps(v) {
  const names = Object.getOwnPropertyNames(v);
  const out = {};
  let n = 0;
  for (const k of names) {
    if (k === 'length' || isIndex(k, v)) continue;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) continue;                 // accessors are skipped (never invoked)
    if (!Array.isArray(v) && d.enumerable) continue;     // plain objects: enumerable keys are copied below
    out[k] = encodeState(d.value);
    n++;
  }
  return n > 0 ? out : null;
}

/** JSON-safe encoding of a state value (Maps, Sets, ±Infinity/NaN, non-enumerable properties). */
export function encodeState(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : { [NUM_TAG]: String(v) };
  if (t === 'string' || t === 'boolean') return v;
  if (t !== 'object') return null;                        // undefined / function / symbol / bigint
  if (Array.isArray(v)) {
    const items = v.map(encodeState);
    const extra = extraProps(v);
    return extra ? { [ARR_TAG]: items, [PROPS_TAG]: extra } : items;
  }
  if (v instanceof Map) {
    const pairs = [];
    for (const [k, x] of v) pairs.push([encodeState(k), encodeState(x)]);
    const extra = extraProps(v);
    return extra ? { [MAP_TAG]: pairs, [PROPS_TAG]: extra } : { [MAP_TAG]: pairs };
  }
  if (v instanceof Set) return { [SET_TAG]: [...v].map(encodeState) };
  const out = {};
  let n = 0;
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d) || !d.enumerable) continue;
    out[k] = encodeState(d.value);
    n++;
  }
  void n;
  const extra = extraProps(v);
  // the marker form only ever holds marker keys, so a plain object never collides with it (see decodeState)
  if (extra) return { [PROPS_TAG]: { ...extra, ...out } };
  return out;
}

/** True when the object holds nothing but marker keys (so it cannot be engine state). */
const markerOnly = (v, ...tags) => {
  const ks = Object.keys(v);
  return ks.length > 0 && ks.every((k) => tags.includes(k));
};

/** Inverse of encodeState. */
export function decodeState(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (Array.isArray(v)) return v.map(decodeState);
  if (t !== 'object') return null;
  if (Object.hasOwn(v, MAP_TAG) && markerOnly(v, MAP_TAG, PROPS_TAG)) {
    return withProps(new Map((v[MAP_TAG] || []).map(([k, x]) => [decodeState(k), decodeState(x)])), v[PROPS_TAG]);
  }
  if (Object.hasOwn(v, ARR_TAG) && markerOnly(v, ARR_TAG, PROPS_TAG)) {
    const arr = (v[ARR_TAG] || []).map(decodeState);
    // a frozen array's extra properties must come back non-enumerable (waves.js `factions.schedule`)
    for (const [k, x] of Object.entries(v[PROPS_TAG] || {})) {
      try { Object.defineProperty(arr, k, { value: decodeState(x), enumerable: false, writable: true, configurable: true }); }
      catch { /* frozen target: nothing sensible to do */ }
    }
    return arr;
  }
  if (markerOnly(v, SET_TAG)) return new Set((v[SET_TAG] || []).map(decodeState));
  if (markerOnly(v, NUM_TAG)) return Number(v[NUM_TAG]);
  if (markerOnly(v, PROPS_TAG)) {
    const out = {};
    for (const [k, x] of Object.entries(v[PROPS_TAG])) out[k] = decodeState(x);
    return out;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = decodeState(x);
  return out;
}

/** Attach decoded extra properties (non-enumerable) to a decoded value. */
function withProps(value, extra) {
  for (const [k, x] of Object.entries(extra || {})) {
    try { Object.defineProperty(value, k, { value: decodeState(x), enumerable: false, writable: true, configurable: true }); }
    catch { /* ignore */ }
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------------------------------

/**
 * Match scalars of a checkpoint. Everything else is either rebuilt by the constructor (gd, ds, stage, players,
 * order, pool, schedulers) or transient (clocks, view plumbing, timers, battle objects).
 */
const MATCH_FIELDS = Object.freeze([
  'roomCode', 'mode', 'difficulty', 'modeId', 'seed', 'isSolo', 'consoleEnabled', 'battlePrefix', 'timerScale', 'gameSpeed',
  'botRehearsal', 'clientCombat', 'verifyMode', 'headlessSliceMs', 'verifyStats', '_battleSeq', 'pausedMs',
  'stageId', 'factions', 'bossId', 'hiddenBossId', 'disabledBonds', 'staticInactiveBonds', 'bannedChess',
  'aiPicksLast', 'setupRevision', '_setupVoteSeq',
  'round', 'uidSeq', 'loneHuman', 'hiddenLayerSum', 'hiddenReached', 'errors', 'errorCount', 'simErrors',
  'simErrorLog', 'draft', 'sp', 'wave', 'bossWaves',
]);

/** PlayerState fields of a checkpoint (bonds/deploy map are recomputed on restore). */
const PLAYER_FIELDS = Object.freeze([
  'playerId', 'seat', 'name', 'isBot', 'connected', 'left', 'autoplay', 'consoleRoundUses', 'consoleTotalUses', 'alive', 'lp', 'bandId', 'funds',
  'pendingFunds', 'ready', 'infoReady', 'lastEmoteAt', 'loadout', 'shop', 'offers', 'hand', 'temp', 'prepsEnded',
  '_tempDue', 'board', 'layers', 'pendingLayerGains', 'bondCountBonus', 'effects', 'bounties', 'counters', 'round',
  'deployCapBonus', 'deployCapMin', 'deviceOverrides', 'tileOverrides', 'stats', 'eliminatedRound', 'lpAtFinal',
  'ops', 'personalChoice', 'lastResult', 'standIns', 'diy', 'diyStock', 'diyBanned',
]);

/** The RNG streams the match owns (server/sim/rng.js createRng, state()/setState). */
const RNG_NAMES = Object.freeze(['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta']);

// ---------------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------------

/**
 * Checkpoint the match, or null when it cannot be checkpointed right now (canSnapshot) — the caller keeps the
 * previous checkpoint in that case.
 * @param {import('./Match.js').Match} m
 * @returns {object | null}
 */
export function snapshotMatch(m) {
  if (!canSnapshot(m)) return null;
  try {
    return buildSnapshot(m);
  } catch {
    // an unserializable state (a cycle, an exotic value) must never break the save loop: the caller keeps the last one
    return null;
  }
}

/** @param {import('./Match.js').Match} m @returns {object} */
function buildSnapshot(m) {
  return encodeMatchCapture(captureMatch(m));
}

/** Select only persistence fields. Nested values are cloned synchronously by Worker.postMessage before yielding.
 * The wave schedule needs an explicit side channel: structured clone drops non-enumerable properties.
 */
export function captureMatch(m) {
  if (!canSnapshot(m)) return null;
  const now = m.sched.now();
  const doc = { v: SNAPSHOT_VERSION, phase: m.phase, round: m.round, savedAt: now };
  for (const k of MATCH_FIELDS) {
    if (k === 'round') continue;
    doc[k] = m[k];
  }
  // the phase clock travels as *remaining* time: the match is frozen while the server is down
  doc.deadlineRemainingMs = m.deadline > 0 ? Math.max(0, Math.round(m.deadline - now)) : 0;
  // Votes are cancelled on restart; retain their paused confirmation budget, not a zero deadline.
  if (m.setupVote && m.phase === PHASE.INFO_CHECK) doc.deadlineRemainingMs = m.setupVote.remainingMs || 0;
  doc.startedAtAgoMs = Math.max(0, Math.round(now - (Number(m.startedAt) || now)));
  // the shared pool: only the remaining copies live in the checkpoint (cap/tier are data-derived)
  doc.poolLeft = {};
  for (const [id, e] of m.pool.entries) doc.poolLeft[id] = e.left;
  // RNG positions: keeps the continuation of a restored match identical to the run it replaces
  doc.rng = {};
  for (const name of RNG_NAMES) {
    const rng = m[name];
    if (rng && typeof rng.state === 'function') doc.rng[name] = rng.state() >>> 0;
  }
  doc.players = m.order.map((ps) => {
    const p = { playerId: ps.playerId };
    for (const k of PLAYER_FIELDS) {
      if (k === 'playerId') continue;
      p[k] = ps[k];
    }
    return p;
  });
  return { doc, factionSchedule: m.factions?.schedule };
}

/** Runs in the persistence Worker (also used by the synchronous diagnostic snapshot API). */
export function encodeMatchCapture(capture) {
  if (!capture) return null;
  const { doc, factionSchedule } = capture;
  // Reattach before encoding: the codec preserves it in the existing snapshot format.
  if (Array.isArray(doc.factions) && factionSchedule !== undefined && !Object.hasOwn(doc.factions, 'schedule')) {
    Object.defineProperty(doc.factions, 'schedule', { value: factionSchedule, enumerable: false });
  }
  const out = { ...doc };
  for (const k of MATCH_FIELDS) if (k !== 'round') out[k] = encodeState(doc[k]);
  out.players = doc.players.map((p) => {
    const encoded = { playerId: p.playerId };
    for (const k of PLAYER_FIELDS) if (k !== 'playerId') encoded[k] = encodeState(p[k]);
    return encoded;
  });
  try {
    // a round trip both validates JSON-safety and normalizes undefined away
    return JSON.parse(JSON.stringify(out));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------------

/**
 * Apply a checkpoint to a fresh Match instance (constructed with the same mode/difficulty/seats and any seed) and
 * re-enter its phase. Timers are re-armed from the remaining times; nothing is re-dispatched (effects, income and
 * round-start hooks already ran before the checkpoint was taken).
 *
 * `createRngFromState` is injected (server/sim/rng.js) so this module stays importable from tests without the sim.
 * @param {import('./Match.js').Match} m fresh instance
 * @param {object} doc checkpoint (snapshotMatch)
 * @param {{ createRngFromState: (state: number) => any, log?: object }} deps
 * @returns {boolean} false when the document does not fit this match (version/phase/player mismatch)
 */
export function restoreMatch(m, doc, { createRngFromState, log = console, bestEffort = false, departedPlayerIds = [] } = {}) {
  if (!m || !doc || typeof doc !== 'object') return false;
  if (!m.sched || typeof m.sched.now !== 'function' || !m.pool || !(m.pool.entries instanceof Map)) return false;
  if (doc.v !== SNAPSHOT_VERSION) {
    log.warn?.(`[snapshot] ${m.roomCode}: checkpoint version ${doc.v}${bestEffort ? '; recovering compatible fields' : ' unsupported'}`);
    if (!bestEffort) return false;
  }
  if (!SNAPSHOT_PHASES.includes(doc.phase) && !bestEffort) { log.warn?.(`[snapshot] ${m.roomCode}: unsupported phase ${doc.phase}`); return false; }
  if (bestEffort && !m.pool.entries.size) { log.warn?.(`[snapshot] ${m.roomCode}: game data unavailable; checkpoint deferred`); return false; }
  const players = Array.isArray(doc.players) ? doc.players : [];
  for (const p of players) if (!m.players.has(p.playerId)) { log.warn?.(`[snapshot] ${m.roomCode}: seat ${p.playerId} missing`); return false; }
  if (players.length !== m.players.size) { log.warn?.(`[snapshot] ${m.roomCode}: ${players.length} of ${m.players.size} seats in the checkpoint`); return false; }
  if (typeof createRngFromState !== 'function') throw new TypeError('restoreMatch: createRngFromState required');

  const now = m.sched.now();
  const initialStage = m.stage;
  const reset = (label, e) => log.warn?.(`[snapshot] ${m.roomCode}: ${label} reset to its compatible default (${e.message})`);
  const field = (target, record, key, label) => {
    if (!Object.hasOwn(record, key)) return;
    if (!bestEffort) { target[key] = decodeState(record[key]); return; }
    try { target[key] = recoverValue(decodeState(record[key]), target[key], label, reset); }
    catch (e) { reset(label, e); }
  };
  for (const k of MATCH_FIELDS) if (k !== 'round') field(m, doc, k, k);
  m.round = Number(doc.round) || 0;
  if (bestEffort && (!Number.isInteger(m.round) || m.round < 0
    || (m.round === 0 && [PHASE.PREP, PHASE.ROUND_START, PHASE.SP_DRAFT].includes(doc.phase)))) {
    m.round = Math.max(1, ...players.map((p) => Number.isInteger(p.prepsEnded) ? p.prepsEnded + 1 : 1));
    log.warn?.(`[snapshot] ${m.roomCode}: invalid round inferred as ${m.round}`);
  }
  m.phase = SNAPSHOT_PHASES.includes(doc.phase) ? doc.phase : m.round > 0 ? PHASE.PREP : PHASE.INFO_CHECK;
  if (m.phase !== doc.phase) log.warn?.(`[snapshot] ${m.roomCode}: phase ${doc.phase} recovered as ${m.phase}`);
  m.ended = false;
  m.disposed = false;
  m.paused = false;          // a solo pause does not survive a restart (the header)
  m._pausedAt = 0;
  m.overtimeAt = 0;
  m.stage = m.stageId ? m.gd.stage(m.stageId) : null;
  if (bestEffort && !m.stage && initialStage) {
    log.warn?.(`[snapshot] ${m.roomCode}: unavailable stage ${m.stageId}; using compatible stage ${initialStage.id}`);
    m.stage = initialStage;
    m.stageId = initialStage.id;
  }
  m.startedAt = now - (Number(doc.startedAtAgoMs) || 0);
  // a re-fought round must never collide with the reports of the interrupted one
  m._battleSeq = (Number(m._battleSeq) || 0) + RESTORE_SEQ_GAP;
  // shared pool: restore the remaining copies onto the data-derived entries
  if (doc.poolLeft && typeof doc.poolLeft === 'object') {
    for (const [id, left] of Object.entries(doc.poolLeft)) {
      const e = m.pool.entries.get(id);
      if (e) e.left = Math.max(0, Math.min(e.cap, Math.trunc(Number(left) || 0)));
    }
  }
  for (const name of RNG_NAMES) {
    const state = doc.rng && doc.rng[name];
    if (Number.isInteger(state)) m[name] = createRngFromState(state >>> 0);
  }
  // transient view / timer plumbing
  m._timers.clear();
  m._phaseTimer = null;
  m._turnTimer = null;
  m._pubTimer = null;
  m._pubDirty = false;
  m._lastPubAt = -Infinity;
  m._lastPubJson = '';
  m._privDirty.clear();
  m._prepEndQueued = false;
  m._turnToken = 0;
  m._progressTimer = null;
  m._bossPubTimer = null;
  m._bossClock = null;
  m._bossClockOn = false;
  m.pacer = null;
  m.runner = null;
  m.fields = [];
  m.watchers.clear();
  m.lastResults.clear();
  m.teamLp = null;
  m.bossPool = null;
  m.unitePlan = null;
  m.lastResultMsg = null;
  m.battlePrefix = typeof m.battlePrefix === 'string' && m.battlePrefix ? m.battlePrefix : `${m.seed.toString(36)}`;
  m.order = [...m.players.values()].sort((a, b) => a.seat - b.seat);

  for (const p of players) {
    const ps = m.players.get(p.playerId);
    for (const k of PLAYER_FIELDS) {
      if (k === 'playerId') continue;
      field(ps, p, k, `${p.playerId}.${k}`);
    }
    if (ps._tempDue === null || !(ps._tempDue instanceof Map)) ps._tempDue = new Map();
    if (ps.board === null || !(ps.board instanceof Map)) ps.board = new Map();
    // derived state
    ps.m = m;
    ps.gd = m.gd;
    // Rebuild the self-selected data view and stock methods; only the saved remaining counts are copied back.
    const stockEntries = ps.diyStock?.entries;
    ps.setNotOwned(ps.standIns || []);
    ps.setDiy(ps.diy || {});
    ps.initDiyStock(new Set([...(m.disabledBonds || []), ...(m.staticInactiveBonds || [])]));
    if (stockEntries instanceof Map) for (const [id, saved] of stockEntries) {
      const entry = ps.diyStock.entries.get(id);
      if (entry) entry.left = Math.max(0, Math.min(entry.cap, Math.trunc(Number(saved.left) || 0)));
    }
    ps.connected = ps.isBot ? true : false;   // every socket is gone: the lobby rebinds on hello
    ps._deployMap = null;
    ps._deployField = undefined;
    ps._legalityStale = true;
    ps._botPrepToken = 0;
    ps._lastPriv = null;
    if (bestEffort) repairPlayer(ps, log);
    ps.recompute();
  }
  m.order = [...m.players.values()].sort((a, b) => a.seat - b.seat);
  if (bestEffort) {
    repairPhase(m, log);
    // Departures must precede re-entry so missing humans cannot stall a draft or participate in a restored boss pair.
    for (const ps of m.order) if (ps.left && ps.alive) {
      ps.left = false;
      m.onLeave(ps.playerId);
    }
    for (const id of departedPlayerIds) if (!m.players.get(id)?.left) m.onLeave(id);
    for (const ps of m.order) {
      for (const piece of [...ps.hand, ...ps.temp, ...ps.board.values()]) {
        if (!piece) continue;
        for (const entry of [piece, ...(Array.isArray(piece.items) ? piece.items : [])]) {
          if (Number.isInteger(entry.uid)) m.uidSeq = Math.max(m.uidSeq, entry.uid);
        }
      }
    }
  }
  if (m.ended) return true;
  try { enterPhase(m, { ...doc, phase: m.phase }, now); }
  catch (e) {
    if (!bestEffort) throw e;
    log.warn?.(`[snapshot] ${m.roomCode}: phase re-entry failed (${e.message}); recovering a playable phase`);
    for (const timer of [...m._timers]) m.cancel(timer);
    m._phaseTimer = m._turnTimer = m._pubTimer = null;
    m._pubDirty = false;
    m._prepEndQueued = false;
    for (const ps of m.order) ps.ready = false;
    m.phase = m.round > 0 ? PHASE.PREP : PHASE.INFO_CHECK;
    m.sp = null;
    enterPhase(m, { ...doc, phase: m.phase }, now);
  }
  return true;
}

/** Preserve compatible state and constructor defaults for missing nested optional fields. */
function recoverValue(value, fallback, label, reset) {
  const invalid = () => { throw new TypeError(`invalid ${label}`); };
  if (fallback == null) return value;
  if (fallback instanceof Map) { if (!(value instanceof Map)) invalid(); return value; }
  if (fallback instanceof Set) { if (!(value instanceof Set)) invalid(); return value; }
  if (Array.isArray(fallback)) { if (!Array.isArray(value)) invalid(); return value; }
  if (typeof value !== typeof fallback || value == null) invalid();
  if (typeof fallback === 'number' && (Number.isNaN(value) || (Number.isFinite(fallback) && !Number.isFinite(value)))) invalid();
  if (typeof fallback !== 'object') return value;
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) invalid();
  const out = { ...value };
  for (const [key, original] of Object.entries(fallback)) {
    if (!Object.hasOwn(value, key)) out[key] = original;
    else {
      try { out[key] = recoverValue(value[key], original, `${label}.${key}`, reset); }
      catch (e) { out[key] = original; reset(`${label}.${key}`, e); }
    }
  }
  return out;
}

/** Discard only unusable inventory entries, keeping the player's economy and other valid pieces. */
function repairPlayer(ps, log) {
  const warn = (what) => log.warn?.(`[snapshot] ${ps.m.roomCode}: ${ps.playerId} repaired ${what}`);
  const piece = (p) => {
    if (!p) return null;
    if (typeof p !== 'object' || !['chess', 'item', 'token'].includes(p.kind) || typeof p.id !== 'string') {
      warn('an invalid piece');
      return null;
    }
    if (p.items != null) {
      if (!Array.isArray(p.items)) { warn('equipped item list'); p.items = []; }
      else p.items = p.items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
    }
    if (!p.meta || typeof p.meta !== 'object') p.meta = {};
    return p;
  };
  ps.hand = ps.hand.map(piece);
  ps.temp = ps.temp.map(piece);
  for (const [key, value] of ps.board) {
    const repaired = piece(value);
    if (!repaired || !/^\d+,\d+$/.test(key)) { warn('an invalid board entry'); ps.board.delete(key); }
    else ps.board.set(key, repaired);
  }
  for (const key of ['effects', 'bounties']) ps[key] = ps[key].filter((entry) => entry && typeof entry === 'object');
  ps.shop.slots = ps.shop.slots.filter((entry) => !entry || typeof entry === 'object');
}

/** Repair only the phase plumbing; never repeat income, round-start effects, purchases or applied choices. */
function repairPhase(m, log) {
  const warn = (text) => log.warn?.(`[snapshot] ${m.roomCode}: ${text}`);
  const ids = new Set(m.players.keys());
  if (m.phase === PHASE.BAND_DRAFT) {
    const d = m.draft;
    if (!d || !Array.isArray(d.order) || !d.picks || typeof d.picks !== 'object') {
      warn('rebuilt strategy draft from saved player selections');
      m.draft = { order: m.order.map((p) => p.playerId), idx: 0,
        picks: Object.fromEntries(m.order.filter((p) => p.bandId).map((p) => [p.playerId, p.bandId])),
        skipsLeft: Object.fromEntries(m.order.map((p) => [p.playerId, m.isSolo ? 0 : m.gd.bandDraft.skipsPerPlayer])),
        untimed: m.soloUntimed, turnDeadline: 0, focus: new Map() };
    } else {
      d.order = [...new Set(d.order.filter((id) => ids.has(id)))];
      for (const id of ids) if (!d.order.includes(id)) d.order.push(id);
      d.idx = Number.isInteger(d.idx) && d.idx >= 0 ? Math.min(d.idx, d.order.length) : 0;
      if (!(d.focus instanceof Map)) d.focus = new Map();
      if (!d.skipsLeft || typeof d.skipsLeft !== 'object') d.skipsLeft = {};
    }
  }
  if (m.phase === PHASE.SP_DRAFT) {
    const s = m.sp;
    if (!s || !Array.isArray(s.cards) || !Array.isArray(s.order) || !s.picks || !s.taken) {
      warn('unusable special draft skipped; saved choices and economy retained');
      m.sp = null;
      m.phase = PHASE.PREP;
    } else {
      s.order = [...new Set(s.order.filter((id) => ids.has(id)))];
      s.idx = Number.isInteger(s.idx) && s.idx >= 0 ? Math.min(s.idx, s.order.length) : 0;
    }
  }
  if (m.round > 0 && [PHASE.PREP, PHASE.ROUND_START, PHASE.SP_DRAFT].includes(m.phase) && !m.wave && !m.bossWaves) {
    warn('rebuilt missing wave without repeating round-start effects');
    if (m.round === m.gd.bossRound || m.round === m.gd.hiddenRound) m._planBossWaves();
    else m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, m.round);
  }
}

/** Re-enter the checkpointed phase (see the header for the clock rules). */
function enterPhase(m, doc, now) {
  const remaining = Math.max(0, Number(doc.deadlineRemainingMs) || 0);
  switch (doc.phase) {
    case PHASE.INFO_CHECK: {
      // solo waits for 准备就绪; co-op keeps the official guard (a fresh one)
      if (m.soloUntimed) m.setDeadline(0);
      else m.setDeadline(Math.max(5, Math.round(remaining / 1000)), () => m.enterBandDraft());
      m.markPublic();
      m.maybeEndInfo();
      break;
    }
    case PHASE.BAND_DRAFT: {
      // the current turn starts over with a full clock (the header)
      if (!m.draft || typeof m.draft !== 'object') { m.draft = null; m.phase = PHASE.INFO_CHECK; m.markPublic(); break; }
      m.draft.turnDeadline = 0;
      m.startDraftTurn();
      break;
    }
    case PHASE.SP_DRAFT: {
      if (!m.sp || typeof m.sp !== 'object') { m.sp = null; m.enterPrep(); break; }
      m.setDeadline(0);
      m.startSpTurn();
      break;
    }
    case PHASE.ROUND_START: {
      m.setDeadline(ROUND_START_SEC, () => m.afterRoundStart(), { silent: m.soloUntimed });
      m.markPublic();
      break;
    }
    case PHASE.PREP: {
      const secs = m.soloUntimed ? null : Math.max(MIN_RECOVER_PREP_SEC, Math.round(remaining / 1000));
      m.setDeadline(secs, () => m.prepDeadline());
      let i = 0;
      for (const ps of m.alivePlayers()) if (ps.botControlled && !ps.ready) m.scheduleBotPrep(ps, i++);
      m.markPublic();
      m.maybeEndPrep();
      break;
    }
    default:
      break;
  }
  void now;
}

// ---------------------------------------------------------------------------------------------------
// diagnostics (tests / tools)
// ---------------------------------------------------------------------------------------------------

/**
 * Encoded state of a match's persisted surface: every field of MATCH_FIELDS / PLAYER_FIELDS plus the pool, the RNG
 * positions and the players. Tests use it to assert a checkpoint restores losslessly (compare the objects, normalizing
 * clock-dependent fields such as `draft.turnDeadline` and `_battleSeq`).
 * @param {import('./Match.js').Match} m
 * @returns {{ match: Record<string, any>, pool: Record<string, number>, rng: Record<string, number|null>, players: Record<string, any> }}
 */
export function matchState(m) {
  const match = {};
  for (const k of MATCH_FIELDS) match[k] = encodeState(m[k]);
  // the draft turn clocks are absolute times of the *old* run: the restored match re-arms them from its own clock
  for (const k of ['draft', 'sp']) if (match[k] && typeof match[k] === 'object') delete match[k].turnDeadline;
  const pool = {};
  for (const [id, e] of m.pool.entries) pool[id] = e.left;
  const rng = {};
  for (const n of RNG_NAMES) rng[n] = m[n] && typeof m[n].state === 'function' ? m[n].state() : null;
  const players = {};
  for (const ps of m.order) {
    const p = {};
    for (const k of PLAYER_FIELDS) p[k] = encodeState(ps[k]);
    players[ps.playerId] = p;
  }
  return { match, pool, rng, players };
}

/** JSON digest of matchState (tests / tools). */
export function matchDigest(m) {
  return JSON.stringify(matchState(m));
}
