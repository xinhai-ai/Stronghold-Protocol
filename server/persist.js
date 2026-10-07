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
//     lost its session is not resumed — the room goes back to the lobby with the players that did survive.
//
// The document is one JSON object under `<prefix>state`, rewritten every `saveMs` (default 10 s) and once on a graceful
// shutdown. State older than the Redis TTL (25 h) is gone; a *stale* document (a Redis that kept state from an older
// run of another version) is refused by its `v` field.

import { captureMatch, SNAPSHOT_VERSION } from './match/snapshot.js';
import { PersistenceWorker } from './workers/persistenceClient.js';
import { t } from '../shared/i18n.js';

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
export function sessionDoc(s, now) {
  return {
    playerId: s.playerId,
    token: s.token,
    name: s.name,
    roomCode: s.roomCode || null,
    loadout: s.loadout || null, notOwned: s.notOwned || null, diy: s.diy || null, lang: s.lang || 'zh-CN',
    resumeWindowMs: typeof s.resumeWindowMs === 'number' && s.resumeWindowMs > 0 ? s.resumeWindowMs : null,
    connected: !!s.connected,
    disconnectedAt: s.connected || s.disconnectedAt == null ? now : s.disconnectedAt,
  };
}

/** One seat of a room. */
function seatDoc(seat) {
  return {
    seat: seat.seat, playerId: seat.playerId, name: seat.name, isBot: !!seat.isBot,
    ready: !!seat.ready, left: !!seat.left, connected: !!seat.connected && !seat.left,
    loadout: seat.loadout || null, notOwned: seat.notOwned || null, diy: seat.diy || null,
  };
}

/** One room (the match checkpoint is added by the Persister). */
export function roomDoc(room) {
  return {
    code: room.code,
    mode: room.mode,
    difficulty: room.difficulty,
    consoleEnabled: !!room.consoleEnabled,
    hostId: room.hostId || null,
    ownerKey: room.ownerKey || null,
    matchKey: room.matchKey || null,
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
  if (matchDocs) {
    for (const [code, doc] of matchDocs) if (doc) matches[code] = doc;
  }
  return {
    v: PERSIST_VERSION,
    snapshot: SNAPSHOT_VERSION,
    savedAt: now,
    sessions: [...registry.all()].map((s) => sessionDoc(s, now)),
    rooms: [...lobby.rooms.values()].map((room) => ({ ...roomDoc(room), hasMatch: !!room.match })),
    matches,
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
  const stats = { ok: false, sessions: 0, expired: 0, rooms: 0, matches: 0, droppedSeats: 0 };
  if (!doc || typeof doc !== 'object') return { ...stats, reason: 'empty' };
  if (doc.v !== PERSIST_VERSION) return { ...stats, reason: `version ${doc.v}` };

  for (const s of Array.isArray(doc.sessions) ? doc.sessions : []) {
    if (!s || typeof s.playerId !== 'string' || typeof s.token !== 'string' || !s.token) continue;
    // a session that was connected when the document was written was cut off by the restart itself: its window starts now
    const since = s.connected === false && Number.isFinite(s.disconnectedAt) ? Number(s.disconnectedAt) : now;
    const windowMs = Number.isFinite(s.resumeWindowMs) && s.resumeWindowMs > 0 ? Number(s.resumeWindowMs) : null;
    const window = windowMs != null && windowMs > registry.reconnectWindowMs ? windowMs : registry.reconnectWindowMs;
    if (now - since > window) { stats.expired++; continue; }
    const session = registry.adopt({
      playerId: s.playerId,
      token: s.token,
      name: typeof s.name === 'string' ? s.name : t('博士'),
      disconnectedAt: since,
      resumeWindowMs: windowMs,
      roomCode: s.roomCode,
      loadout: s.loadout, notOwned: s.notOwned, diy: s.diy, lang: s.lang,
      addr: s.addr,
    });
    if (session) stats.sessions++;
  }

  const result = lobby.restoreRooms(Array.isArray(doc.rooms) ? doc.rooms : [], { now });
  stats.rooms = result.rooms;
  stats.droppedSeats = result.droppedSeats;

  const matches = doc.matches && typeof doc.matches === 'object' ? doc.matches : {};
  for (const room of lobby.rooms.values()) {
    const checkpoint = matches[room.code];
    if (!checkpoint) continue;
    if (lobby.restoreMatch(room, checkpoint)) stats.matches++;
    else log.warn?.(`[persist] ${room.code}: the running match could not be resumed — room kept in the lobby`);
  }
  for (const [key, checkpoint] of Object.entries(matches)) {
    if (!key.startsWith('queue:') || !checkpoint) continue;
    if (lobby.restoreQueuedMatch(checkpoint)) stats.matches++;
    else log.warn?.(`[persist] ${key}: the standalone matchmaking match could not be resumed`);
  }
  stats.ok = true;
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
  }

  entries() {
    return this.lobby.persistenceMatches().map((item) => {
      if (!this.generations.has(item.match)) this.generations.set(item.match, ++this.generationSeq);
      return { ...item, generation: this.generations.get(item.match) };
    });
  }

  /** Keep loaded checkpoints even if the restored match enters combat before the first save. */
  async seed(doc) {
    const entries = this.entries().map(({ key, generation }) => ({ key, generation }));
    const { bytes } = await this.encoder.request('seed', { doc, entries });
    this.encoder.remember(bytes, entries);
    this.checkpointKeys = new Set(entries.filter(({ key }) => doc.matches?.[key]).map(({ key }) => key));
  }

  /** Post each capture immediately, before yielding: mutations cannot interleave with a match's structured clone. */
  async checkpointMatches() {
    for (const item of this.lobby.persistenceMatches()) {
      const capture = captureMatch(item.match);
      if (!capture) continue;
      if (!this.generations.has(item.match)) this.generations.set(item.match, ++this.generationSeq);
      await this.encoder.request('checkpoint', { key: item.key, generation: this.generations.get(item.match), capture });
      this.checkpointKeys.add(item.key);
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
    if (!this.store || this._busy) return false;
    this._busy = true;
    this._flush = this.write(reason);
    try { return await this._flush; }
    finally { this._busy = false; this._flush = null; }
  }

  async write(reason) {
    try {
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
  }

  /** Stop and write the final document. */
  async shutdown(reason = 'shutdown') {
    this.stop();
    if (this._flush) await this._flush;
    try { return await this.flush(reason); }
    finally { await this.encoder.close(); }
  }
}
