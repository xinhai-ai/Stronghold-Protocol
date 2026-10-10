// server/persist.js — the server's state document (Redis, docs/DEPLOY.md「断点续玩」).
//
// WHAT SURVIVES A RESTART
//   * Sessions — playerId, secret token, nickname, operator loadout, the room they are in and their reconnect window.
//     A client that reconnects with its token after a restart is the same player, with the same seat.
//   * Rooms — code, mode, difficulty, host, seats (humans + AI), who is ready, the room's match counter.
//   * Running matches (including standalone and room-bound matchmaking matches) — via server/match/snapshot.js: the
//     *last checkpoint*, which is only taken in the phases whose
//     state is fully serializable (INFO_CHECK / BAND_DRAFT / SP_DRAFT / ROUND_START / PREP). A match interrupted during
//     a battle therefore resumes at the start of the round it was in: same round, operators, items, economy, LP and
//     pool, with the round's battle fought again. A match that never reached a checkpoint (it started during the last
//     seconds before the crash) comes back as an empty room.
//
// WHAT DOES NOT
//   * The sockets themselves (every client reconnects and is rebound by its token — that is the point).
//   * A solo pause (g.pause) and the exact remaining clock of a battle: on restore the phase clock restarts from the
//     remaining time the checkpoint recorded, with at least 20 s of prep (snapshot.MIN_RECOVER_PREP_SEC).
//   * A session whose reconnect window elapsed while the server was down (10 min for a co-op room, 24 h for a solo run:
//     lobby.soloReconnectWindowMs). Its room is dropped too when nobody is left in it; a running match whose human seat
//     lost its session leaves the restored match; the other valid identities continue. A checkpoint with no usable
//     human identity is retained for a later recovery attempt. Latest departures travel separately from checkpoints.
//
// The document is one JSON object under `<prefix>state`, rewritten every `saveMs` (default 10 s) and once on a graceful
// shutdown. State older than the Redis TTL (25 h) is gone; a *stale* document (a Redis that kept state from an older
// run of another version) is recovered only through compatible fields, with diagnostics and retained failed records.

import { captureMatch, SNAPSHOT_VERSION } from './match/snapshot.js';
import { PersistenceWorker } from './workers/persistenceClient.js';
import { t } from '../shared/i18n.js';
import { DIFFICULTIES, MAX_SEATS, ROOM_CODE_LEN } from '../shared/constants.js';

/** Document layout version (bumped when the shape below changes). */
export const PERSIST_VERSION = 1;
/** Default interval between state writes (ms). */
export const SAVE_MS = 10_000;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------------

/**
 * One session as persisted. `disconnectedAt` is the moment its socket dropped; a session that was connected when the
 * document was written gets the write time (the crash is what cut it off — see the header).
 * @param {import('./net.js').Session} s
 * @param {number} now
 */
export function sessionDoc(s, now, activeMatchKey = null) {
  return {
    playerId: s.playerId,
    token: s.token,
    name: s.name,
    roomCode: s.roomCode || null,
    loadout: s.loadout || null, ops: s.ops || null, notOwned: s.notOwned || null, diy: s.diy || null, lang: s.lang || 'zh-CN',
    resumeWindowMs: typeof s.resumeWindowMs === 'number' && s.resumeWindowMs > 0 ? s.resumeWindowMs : null,
    connected: !!s.connected,
    disconnectedAt: s.connected || s.disconnectedAt == null ? now : s.disconnectedAt,
    activeMatchKey,
    notice: s.notice || null,
    pendingResult: s.pendingResult || null,
  };
}

/** One seat of a room. */
function seatDoc(seat) {
  return {
    seat: seat.seat, playerId: seat.playerId, name: seat.name, isBot: !!seat.isBot,
    ready: !!seat.ready, left: !!seat.left, connected: !!seat.connected && !seat.left,
    loadout: seat.loadout || null, ops: seat.ops || null, notOwned: seat.notOwned || null, diy: seat.diy || null,
  };
}

/** One room (the match checkpoint is added by the Persister). */
export function roomDoc(room) {
  return {
    code: room.code,
    mode: room.mode,
    difficulty: room.difficulty,
    consoleEnabled: !!room.consoleEnabled, aiPicksLast: !!room.aiPicksLast,
    hostId: room.hostId || null,
    ownerKey: room.ownerKey || null,
    matchKey: room.matchKey || null,
    queueMatch: !!room.matchCtx?.queue,
    matchCount: room.matchCount | 0,
    seats: room.seats.filter(Boolean).map(seatDoc),
  };
}

/**
 * The whole document.
 * @param {{ registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby, matchDocs?: Map<string, object>, now: number }} args
 */
export function snapshotServer({ registry, lobby, matchDocs = null, now = Date.now() }) {
  const matches = {};
  const matchDepartures = {};
  const matchBattleSeq = {};
  if (matchDocs) {
    for (const [code, doc] of matchDocs) if (doc) matches[code] = doc;
  }
  // Membership may change during combat, while the last safe game checkpoint stays in PREP.
  for (const { key, match, ctx, room } of lobby.persistenceMatches()) {
    const previous = lobby.recoveryDocs?.get(key);
    if (previous) {
      const archiveKey = `superseded:${key}:${previous.checkpoint?.seed}:${previous.checkpoint?.savedAt}`;
      lobby.recoveryDocs.set(archiveKey, { ...previous, key, superseded: true });
      lobby.recoveryDocs.delete(key);
    }
    // Main-thread membership is authoritative even if a Worker dies before acknowledging onLeave.
    const departed = [...new Set([...(match.order || []), ...(ctx?.members || []), ...(room?.seats || [])]
      .filter((p) => p && !p.isBot && p.left).map((p) => p.playerId))];
    if (departed.length) matchDepartures[key] = departed;
    if (Number.isInteger(match._battleSeq)) matchBattleSeq[key] = match._battleSeq;
  }
  return {
    v: PERSIST_VERSION,
    snapshot: SNAPSHOT_VERSION,
    savedAt: now,
    sessions: [...registry.all()].map((s) => {
      const ctx = lobby.activeMatchOf?.(s);
      const key = ctx?.match && !ctx.ended && !ctx.disposed ? ctx.queue && !ctx.room ? `queue:${ctx.match.roomCode}` : ctx.room?.code || s.roomCode : null;
      return sessionDoc(s, now, key);
    }),
    rooms: [...lobby.rooms.values()].map((room) => ({ ...roomDoc(room), hasMatch: !!room.match })),
    matches,
    matchDepartures,
    matchBattleSeq,
    recovery: Object.fromEntries(lobby.recoveryDocs || []),
  };
}

// ---------------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------------

/**
 * Re-create the sessions of a document (expired ones are dropped), then the rooms, then the running matches.
 * Never throws: an unusable document is refused with a log line.
 * @param {{
 *   doc: object, registry: import('./net.js').SessionRegistry, lobby: import('./lobby.js').Lobby,
 *   now?: number, log?: object,
 * }} args
 * @returns {{ ok: boolean, reason?: string, sessions: number, expired: number, rooms: number, matches: number, droppedSeats: number }}
 */
export function restoreServer({ doc, registry, lobby, now = Date.now(), log = noopLog }) {
  const stats = { ok: false, sessions: 0, expired: 0, rooms: 0, matches: 0, droppedSeats: 0, deferredMatches: 0 };
  if (!doc || typeof doc !== 'object') return { ...stats, reason: 'empty' };
  if (doc.v !== PERSIST_VERSION) {
    if (!Array.isArray(doc.sessions) || (!Array.isArray(doc.rooms) && !doc.matches)
      || (!doc.sessions.length && !doc.rooms?.length && !Object.keys(doc.matches || {}).length && !Object.keys(doc.recovery || {}).length)) {
      return { ...stats, reason: `version ${doc.v}` };
    }
    log.warn?.(`[persist] document version ${doc.v}: attempting recovery of compatible records`);
  }

  const retained = doc.recovery && typeof doc.recovery === 'object' ? doc.recovery : {};
  const matches = new Map(Object.entries(doc.matches && typeof doc.matches === 'object' ? doc.matches : {}));
  for (const [key, entry] of Object.entries(retained)) {
    if (entry?.superseded) { lobby.recoveryDocs?.set(key, entry); stats.deferredMatches++; }
    else if (!matches.has(key) && entry?.checkpoint) matches.set(key, entry.checkpoint);
  }
  const sessionDocs = new Map();
  for (const s of [...(Array.isArray(doc.sessions) ? doc.sessions : []),
    ...Object.values(retained).flatMap((entry) => !entry?.superseded && Array.isArray(entry?.sessions) ? entry.sessions : [])]) {
    if (s && typeof s.playerId === 'string' && s.playerId && typeof s.token === 'string' && s.token && !sessionDocs.has(s.playerId)) sessionDocs.set(s.playerId, s);
  }
  const activeIds = new Set([...matches.values()].flatMap((cp) => Array.isArray(cp?.players)
    ? cp.players.filter((p) => p && !p.isBot && !p.left).map((p) => p.playerId) : []));
  const sessionMatchKeys = new Map([...sessionDocs].filter(([, s]) => typeof s.activeMatchKey === 'string').map(([id, s]) => [id, s.activeMatchKey]));

  for (const s of [...sessionDocs.values()].sort((a, b) => Number(activeIds.has(b.playerId)) - Number(activeIds.has(a.playerId)))) {
    // a session that was connected when the document was written was cut off by the restart itself: its window starts now
    const since = s.connected === false && Number.isFinite(s.disconnectedAt) ? Number(s.disconnectedAt) : now;
    const windowMs = Number.isFinite(s.resumeWindowMs) && s.resumeWindowMs > 0 ? Number(s.resumeWindowMs) : null;
    const window = windowMs != null && windowMs > registry.reconnectWindowMs ? windowMs : registry.reconnectWindowMs;
    if (now - since > window) { stats.expired++; continue; }
    try {
      const session = registry.adopt({
        playerId: s.playerId,
        token: s.token,
        name: typeof s.name === 'string' ? s.name : t('博士'),
        disconnectedAt: since,
        resumeWindowMs: windowMs,
        roomCode: s.roomCode,
        loadout: s.loadout, ops: s.ops, notOwned: s.notOwned, diy: s.diy, lang: s.lang,
        addr: s.addr,
        notice: s.notice, pendingResult: s.pendingResult,
      }, { allowOverCapacity: activeIds.has(s.playerId) });
      if (session) stats.sessions++;
      else log.warn?.(`[persist] session ${s.playerId} could not be adopted; other sessions continue`);
    } catch (e) { log.warn?.(`[persist] session ${s.playerId} restore failed (${e.message}); other sessions continue`); }
  }

  const departures = (key) => Array.isArray(doc.matchDepartures?.[key]) ? doc.matchDepartures[key]
    : Array.isArray(retained[key]?.departedPlayerIds) ? retained[key].departedPlayerIds : [];
  const roomDocs = new Map();
  for (const r of [...(Array.isArray(doc.rooms) ? doc.rooms : []), ...Object.values(retained).filter((entry) => !entry?.superseded).map((entry) => entry?.room)]) {
    if (r && typeof r.code === 'string' && r.code.length === ROOM_CODE_LEN && !roomDocs.has(r.code)) roomDocs.set(r.code, r);
  }
  for (const [key, cp] of matches) if (!key.startsWith('queue:') && key.length === ROOM_CODE_LEN && !roomDocs.has(key) && cp) {
    roomDocs.set(key, { code: key, mode: cp.mode, difficulty: cp.difficulty, seats: [], queueMatch: true });
    log.warn?.(`[persist] ${key}: rebuilding missing room from its checkpoint`);
  }
  for (const [key, original] of roomDocs) {
    try {
      const cp = matches.get(key);
      const players = Array.isArray(cp?.players) ? cp.players.filter((p) => p && typeof p.playerId === 'string') : [];
      const seats = Array.isArray(original.seats) ? original.seats.filter((s) => s && typeof s.playerId === 'string').map((s) => ({ ...s })) : [];
      const hasHuman = seats.some((s) => !s.isBot && !s.left && registry.byId(s.playerId));
      // An owning room can disappear while its public teammates and checkpoint survive.
      if (!hasHuman && cp) for (const p of players) {
        if (p.isBot || p.left || !registry.byId(p.playerId) || departures(key).includes(p.playerId)) continue;
        const owner = sessionMatchKeys.get(p.playerId);
        if (owner && owner !== key) continue;
        if (!seats.some((s) => s.playerId === p.playerId)) seats.push({ ...p, left: false });
        const session = registry.byId(p.playerId);
        if (!session.roomCode || !roomDocs.has(session.roomCode)) session.roomCode = key;
      }
      const used = new Set(), ids = new Set();
      const normalized = seats.filter((s) => {
        if (ids.has(s.playerId) || ids.size >= MAX_SEATS) return false;
        ids.add(s.playerId);
        if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat >= MAX_SEATS || used.has(s.seat)) {
          s.seat = Array.from({ length: MAX_SEATS }, (_, i) => i).find((i) => !used.has(i));
        }
        used.add(s.seat);
        if (cp && (!registry.byId(s.playerId) || departures(key).includes(s.playerId))) s.left = !s.isBot;
        return true;
      });
      const record = { ...original, seats: normalized, mode: original.mode === 'solo' ? 'solo' : 'coop',
        difficulty: DIFFICULTIES.includes(original.difficulty) ? original.difficulty : DIFFICULTIES.includes(cp?.difficulty) ? cp.difficulty : 'NORMAL' };
      const result = lobby.restoreRooms([record], { now });
      stats.rooms += result.rooms;
      stats.droppedSeats += result.droppedSeats;
    } catch (e) { log.warn?.(`[persist] ${key}: room restore failed (${e.message}); other rooms continue`); }
  }
  const ordered = [...matches].sort(([ak, a], [bk, b]) => Number(Object.hasOwn(retained, ak)) - Number(Object.hasOwn(retained, bk))
    || (Number(b?.savedAt) || 0) - (Number(a?.savedAt) || 0));
  const pendingRestores = [];
  const deferMatch = (key, raw) => {
    stats.deferredMatches++;
    const ids = new Set(Array.isArray(raw.players) ? raw.players.map((p) => p?.playerId) : []);
    lobby.recoveryDocs?.set(key, { checkpoint: raw, room: roomDocs.get(key) || null,
      sessions: [...sessionDocs.values()].filter((s) => ids.has(s.playerId)), departedPlayerIds: departures(key),
      battleSeq: Number(doc.matchBattleSeq?.[key]) || Number(retained[key]?.battleSeq) || 0 });
    log.warn?.(`[persist] ${key}: checkpoint retained for a later recovery attempt`);
  };
  for (const [key, raw] of ordered) {
    if (!raw) continue;
    let restored = false;
    try {
      const checkpoint = { ...raw, roomCode: key.startsWith('queue:') ? key.slice(6) : key,
        _battleSeq: Math.max(Number(raw._battleSeq) || 0, Number(doc.matchBattleSeq?.[key]) || Number(retained[key]?.battleSeq) || 0) };
      const opts = { departedPlayerIds: departures(key), sessionMatchKeys };
      const room = lobby.getRoom(key);
      restored = key.startsWith('queue:') ? lobby.restoreQueuedMatch(checkpoint, opts)
        : !!room && lobby.restoreMatch(room, checkpoint, { ...opts, queue: roomDocs.get(key)?.queueMatch === true });
    } catch (e) { log.warn?.(`[persist] ${key}: match restore failed (${e.message}); other matches continue`); }
    if (restored && typeof restored.then === 'function') {
      pendingRestores.push(Promise.resolve(restored).then((ok) => {
        if (ok) { stats.matches++; lobby.recoveryDocs?.delete(key); }
        else deferMatch(key, raw);
      }).catch(() => deferMatch(key, raw)));
    } else if (restored) { stats.matches++; lobby.recoveryDocs?.delete(key); }
    else deferMatch(key, raw);
  }
  stats.ok = true;
  if (pendingRestores.length) stats.ready = Promise.all(pendingRestores).then(() => stats);
  return stats;
}

// ---------------------------------------------------------------------------------------------------
// periodic writer
// ---------------------------------------------------------------------------------------------------

/**
 * Keeps the Redis document up to date: every tick it refreshes the checkpoint of each running match that is in a
 * checkpointable phase. A dedicated Worker encodes and caches checkpoints and serializes the document; the main
 * thread only selects fields and sends one match at a time. A graceful shutdown waits for writes before saving again.
 */
export class Persister {
  /**
   * @param {{
   *   store: { save: (doc: object) => Promise<boolean>, saveSerialized?: (bytes: Buffer) => Promise<boolean>, log?: object },
   *   registry: import('./net.js').SessionRegistry,
   *   lobby: import('./lobby.js').Lobby,
   *   log?: object, now?: () => number, saveMs?: number,
   * }} opts
   */
  constructor({ store, registry, lobby, log = noopLog, now = Date.now, saveMs = SAVE_MS }) {
    this.store = store;
    this.registry = registry;
    this.lobby = lobby;
    this.log = log;
    this.now = now;
    this.saveMs = Math.max(1000, Number(saveMs) || SAVE_MS);
    /** Keys of safe checkpoints; their contents live in the persistence Worker. */
    this.checkpointKeys = new Set();
    this.encoder = new PersistenceWorker();
    this.generations = new WeakMap();
    this.generationSeq = 0;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.writes = 0;
    this.skipped = 0;
    this.failures = 0;
    this.running = false;
    this._busy = false;
    this._flush = null;
    this.pendingLoad = false;
    this._startFlush = false;
    this._startFlushTimer = null;
    this.previousMatchStarted = lobby.onMatchStarted;
    this.matchStarted = (item) => {
      try { this.previousMatchStarted?.(item); }
      catch (e) { this.log.warn?.(`[persist] ${item.key}: previous start hook failed (${e.message}); checkpoint capture continues`); }
      // request() structured-clones the capture before the next client action can mutate the match.
      this.checkpoint(item).then((captured) => {
        if (captured && this.running) this.flush('match-start').catch(() => {});
      }).catch((e) => this.log.warn?.(`[persist] ${item.key}: initial checkpoint failed (${e.message})`));
    };
    lobby.onMatchStarted = this.matchStarted;
  }

  entries() {
    return this.lobby.persistenceMatches().map((item) => {
      if (!this.generations.has(item.match)) this.generations.set(item.match, ++this.generationSeq);
      return { ...item, generation: this.generations.get(item.match) };
    });
  }

  /** A failed startup read must not let a later write replace a state document that was never recovered. */
  deferLoad() {
    this.pendingLoad = true;
    this.registry.recoveryPending = true;
  }

  async retryLoad() {
    const doc = await this.store.load({ attempts: 1 });
    if (!doc && ['unavailable', 'invalid'].includes(this.store.loadState)) return false;
    if (doc) {
      const initialStats = restoreServer({ doc, registry: this.registry, lobby: this.lobby, now: this.now(), log: this.log });
      const stats = initialStats.ready ? await initialStats.ready : initialStats;
      if (!stats.ok) return false;
      await this.seed(doc);
      this.log.info?.(`[persist] deferred state loaded (${stats.matches} match(es), ${stats.deferredMatches} checkpoint(s) retained)`);
    }
    this.pendingLoad = false;
    this.registry.recoveryPending = false;
    return true;
  }

  /** Keep loaded checkpoints even if the restored match enters combat before the first save. */
  async seed(doc) {
    const live = this.entries();
    const entries = live.map(({ key, generation }) => ({ key, generation }));
    const matches = {};
    for (const { key, match } of live) {
      const cp = doc.matches?.[key] || doc.recovery?.[key]?.checkpoint;
      if (!cp) continue;
      if ((cp.seed != null && Number.isFinite(Number(cp.seed)) && Number(cp.seed) !== match.seed)
        || (typeof cp.battlePrefix === 'string' && cp.battlePrefix && cp.battlePrefix !== match.battlePrefix)) continue;
      matches[key] = cp;
    }
    const seedDoc = { ...doc, matches };
    this.encoder.rememberDocument(seedDoc, entries);
    this.checkpointKeys = new Set(entries.filter(({ key }) => matches[key]).map(({ key }) => key));
    try {
      const { bytes } = await this.encoder.request('seed', { doc: seedDoc, entries });
      this.encoder.remember(bytes, entries);
      return true;
    } catch (e) {
      this.failures++;
      this.log.warn?.(`[persist] checkpoint Worker seed failed (${e.message}); loaded checkpoints retained for retry`);
      return false;
    }
  }

  /** Post each capture immediately, before yielding: mutations cannot interleave with a match's structured clone. */
  async checkpointMatches() {
    for (const item of this.lobby.persistenceMatches()) {
      await this.checkpoint(item);
    }
  }

  async checkpoint(item) {
    try {
      if (typeof item.match.captureSnapshotBytes === 'function') {
        const bytes = await item.match.captureSnapshotBytes();
        if (!bytes) return false;
        if (!this.generations.has(item.match)) this.generations.set(item.match, ++this.generationSeq);
        // Transfer ownership onward without inspecting/decoding the capture on the main thread.
        await this.encoder.request('checkpointBytes', { key: item.key, generation: this.generations.get(item.match), bytes }, [bytes.buffer]);
        this.checkpointKeys.add(item.key);
        return true;
      }
      const capture = typeof item.match.captureSnapshot === 'function'
        ? await item.match.captureSnapshot()
        : captureMatch(item.match);
      if (!capture) return false;
      if (!this.generations.has(item.match)) this.generations.set(item.match, ++this.generationSeq);
      await this.encoder.request('checkpoint', { key: item.key, generation: this.generations.get(item.match), capture });
      this.checkpointKeys.add(item.key);
      return true;
    } catch (e) {
      this.failures++;
      this.log.warn?.(`[persist] ${item.key}: checkpoint capture failed (${e.message}); retaining its last checkpoint and saving other matches`);
      return false;
    }
  }

  async serialized() {
    await this.checkpointMatches();
    // Re-enumerate after yields: ended matches or a new match in the same room must never get an old checkpoint.
    const entries = this.entries().map(({ key, generation }) => ({ key, generation }));
    const doc = snapshotServer({ registry: this.registry, lobby: this.lobby, now: this.now() });
    const result = await this.encoder.request('serialize', { doc, entries });
    this.checkpointKeys = new Set(result.keys);
    return { ...result, entries };
  }

  /** Diagnostic API only: decoding a whole document here does run on the calling thread. */
  async document() {
    const { bytes } = await this.serialized();
    return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
  }

  /** One save round (never throws). */
  async flush(reason = 'tick') {
    if (!this.store) return false;
    if (this._busy) {
      if (reason === 'match-start') this._startFlush = true;
      if (['tick', 'interval', 'match-start'].includes(reason)) return false;
      await this._flush;
      return this.flush(reason);
    }
    this._startFlush = false;
    if (this._startFlushTimer) { clearImmediate(this._startFlushTimer); this._startFlushTimer = null; }
    this._busy = true;
    this._flush = this.write(reason);
    try { return await this._flush; }
    finally {
      this._busy = false;
      this._flush = null;
      if (this._startFlush && this.running && !this._startFlushTimer) {
        this._startFlush = false;
        this._startFlushTimer = setImmediate(() => {
          this._startFlushTimer = null;
          if (this.running) this.flush('match-start').catch(() => {});
        });
        this._startFlushTimer.unref?.();
      }
    }
  }

  async write(reason) {
    try {
      if (this.pendingLoad && !await this.retryLoad()) { this.skipped++; return false; }
      const { bytes, entries } = await this.serialized();
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Real Redis takes already encoded bytes. Legacy injected stores retain their object API (tests / diagnostics).
      const ok = typeof this.store.saveSerialized === 'function'
        ? await this.store.saveSerialized(buffer)
        : await this.store.save(JSON.parse(buffer.toString('utf8')));
      if (ok) { this.writes++; this.encoder.remember(bytes, entries); }
      else { this.failures++; this.log.debug?.(`[persist] write skipped (${reason})`); }
      return ok;
    } catch (e) {
      this.failures++;
      this.log.warn?.('[persist] save failed', e);
      return false;
    }
  }

  start() {
    if (this.running || !this.store) return this;
    this.running = true;
    this.timer = setInterval(() => { this.flush('interval').catch(() => {}); }, this.saveMs);
    this.timer.unref?.();
    return this;
  }

  /** Stop the interval. Does not flush (call flush() first when the process is shutting down). */
  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._startFlushTimer) { clearImmediate(this._startFlushTimer); this._startFlushTimer = null; }
    this._startFlush = false;
  }

  /** Stop and write the final document. */
  async shutdown(reason = 'shutdown') {
    this.stop();
    if (this._flush) await this._flush;
    try { return await this.flush(reason); }
    finally {
      if (this.lobby.onMatchStarted === this.matchStarted) this.lobby.onMatchStarted = this.previousMatchStarted;
      await this.encoder.close();
    }
  }
}
