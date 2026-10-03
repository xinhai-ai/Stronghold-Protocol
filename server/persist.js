// server/persist.js — the server's state document (Redis, docs/DEPLOY.md「断点续玩」).
//
// WHAT SURVIVES A RESTART
//   * Sessions — playerId, secret token, nickname, operator loadout, the room they are in and their reconnect window.
//     A client that reconnects with its token after a restart is the same player, with the same seat.
//   * Rooms — code, mode, difficulty, host, seats (humans + AI), who is ready, the room's match counter.
//   * Running matches — via server/match/snapshot.js: the *last checkpoint*, which is only taken in the phases whose
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

import { snapshotMatch, restoreMatch, canSnapshot, SNAPSHOT_VERSION } from './match/snapshot.js';

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
    loadout: s.loadout || null,
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
    loadout: seat.loadout || null,
  };
}

/** One room (the match checkpoint is added by the Persister). */
export function roomDoc(room) {
  return {
    code: room.code,
    mode: room.mode,
    difficulty: room.difficulty,
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
      name: typeof s.name === 'string' ? s.name : '博士',
      disconnectedAt: since,
      resumeWindowMs: windowMs,
      roomCode: s.roomCode,
      loadout: s.loadout,
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
  stats.ok = true;
  return stats;
}

// ---------------------------------------------------------------------------------------------------
// periodic writer
// ---------------------------------------------------------------------------------------------------

/**
 * Keeps the Redis document up to date: every tick it refreshes the checkpoint of each running match that is in a
 * checkpointable phase, then writes the whole document (skipping identical writes), and finally writes once more on
 * stop() so a graceful shutdown never loses the last state.
 */
export class Persister {
  /**
   * @param {{
   *   store: { save: (doc: object) => Promise<boolean>, log?: object },
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
    /** @type {Map<string, object>} room code → last safe match checkpoint */
    this.matchDocs = new Map();
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.writes = 0;
    this.skipped = 0;
    this.failures = 0;
    this.running = false;
    this._busy = false;
  }

  /** Refresh the checkpoint of every running match (a placeholder document while none is safe yet is *not* written). */
  checkpointMatches() {
    for (const [code, room] of this.lobby.rooms) {
      if (room.disposed || !room.match) { this.matchDocs.delete(code); continue; }
      if (!canSnapshot(room.match)) continue;                     // keep the last safe checkpoint
      const doc = snapshotMatch(room.match);
      if (doc) this.matchDocs.set(code, doc);
    }
    for (const code of [...this.matchDocs.keys()]) if (!this.lobby.rooms.has(code)) this.matchDocs.delete(code);
  }

  /** Build the document without writing it (tests / diagnostics). */
  document() {
    this.checkpointMatches();
    return snapshotServer({ registry: this.registry, lobby: this.lobby, matchDocs: this.matchDocs, now: this.now() });
  }

  /** One save round (never throws). */
  async flush(reason = 'tick') {
    if (!this.store || this._busy) return false;
    this._busy = true;
    try {
      const doc = this.document();
      const ok = await this.store.save(doc);
      if (ok) this.writes++;
      else { this.failures++; this.log.debug?.(`[persist] write skipped (${reason})`); }
      return ok;
    } catch (e) {
      this.failures++;
      this.log.warn?.('[persist] save failed', e);
      return false;
    } finally {
      this._busy = false;
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
    return this.flush(reason);
  }
}
