// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.kick, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//     Defaults live in LOBBY_DEFAULTS and can be overridden per startServer option or with the SP_MAX_ROOMS,
//     SP_MAX_ROOMS_PER_ADDR and SP_MAX_MATCHES_PER_ADDR environment variables (docs/DEPLOY.md §3.4); every refusal
//     is logged (`room limit (N) reached …` / `match limit (N) reached …`, throttled to one line per 10 s).
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout (stored for its session,
//     never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt } from 'node:crypto';
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { checkLoadout } from '../shared/protocol.js';
import { encode, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { restoreMatch as applyMatchCheckpoint } from './match/snapshot.js';
import { createRngFromState } from './sim/rng.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  matchmakingWaitMs: 60_000,   // queue wait before an AI teammate is added
  matchmakingTickMs: 1_000,    // queue scheduling cadence
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']);

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null }} Seat
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    /** @type {{ queueId: string, queuedAt: number, deadlineAt: number, fillBots: boolean } | null} */
    this.matching = null;
    this.createdAt = now;
    this.disposed = false;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      inMatch: !!this.match,
      matching: this.matching ? { ...this.matching } : null,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected })),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   *   workerPool?: object | null,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {}, workerPool = null }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.workerPool = workerPool;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /** @type {Map<string, any[]>} queue buckets keyed by mode + difficulty */
    this.matchQueues = new Map();
    /** @type {Map<string, any>} one active queue entry per human player */
    this.queueByPlayer = new Map();
    this.queueSeq = 0;
    this.matchQueueTimer = setInterval(() => this.processMatchQueues(), Math.max(100, Number(this.opts.matchmakingTickMs) || 1000));
    this.matchQueueTimer.unref?.();
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let queued = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    const entries = new Set(this.queueByPlayer.values());
    queued = entries.size;
    return { rooms: this.rooms.size, matches, humans, bots, spectators, queued };
  }

  /**
   * Aggregate per-network room/match usage for /healthz (docs/DEPLOY.md §3.4): how many client networks are already at
   * one of the caps and how close the worst one is. No addresses here — /healthz is public, the refusal logs name the
   * network (`room limit (16) reached for 203.0.113.7`).
   * @returns {{ rooms: number, matches: number, networks: number, worstRooms: number, worstMatches: number,
   *             overRooms: number, overMatches: number }}
   */
  usage() {
    /** @type {Map<string, { rooms: number, matches: number }>} */
    const per = new Map();
    let matches = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      if (!r.ownerKey) continue;
      const e = per.get(r.ownerKey) || { rooms: 0, matches: 0 };
      e.rooms++;
      if (r.match) e.matches++;
      per.set(r.ownerKey, e);
    }
    let worstRooms = 0;
    let worstMatches = 0;
    let overRooms = 0;
    let overMatches = 0;
    for (const e of per.values()) {
      if (e.rooms > worstRooms) worstRooms = e.rooms;
      if (e.matches > worstMatches) worstMatches = e.matches;
      if (this.opts.maxRoomsPerAddr > 0 && e.rooms >= this.opts.maxRoomsPerAddr) overRooms++;
      if (this.opts.maxMatchesPerAddr > 0 && e.matches >= this.opts.maxMatchesPerAddr) overMatches++;
    }
    return { rooms: this.rooms.size, matches, networks: per.size, worstRooms, worstMatches, overRooms, overMatches };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    const active = this.activeMatchOf(session);
    if (!room) {
      if (active && active.match && !active.ended) {
        this.callMatchContext(active, 'onReconnect', session.playerId);
        return;
      }
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'match.join': return this.matchJoin(session, msg);
      case 'match.leave': return this.matchLeave(session);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const queued = this.queueByPlayer.get(session.playerId);
    if (queued) this.cancelMatchQueue(queued, 'disconnect');
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    const active = this.activeMatchOf(session);
    if (!room && !active) return;
    if (!room && active) {
      this.callMatchContext(active, 'onDisconnect', session.playerId);
      return;
    }
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    if (!seat) return;
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (active || room.match) { if (player) this.callMatchContext(active || room.matchCtx, 'onDisconnect', session.playerId); }
    else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const queued = this.queueByPlayer.get(session.playerId);
    if (queued) this.cancelMatchQueue(queued, 'expired');
    const active = this.activeMatchOf(session);
    const roomCode = session.roomCode;
    if (active && !roomCode && !active.ended) {
      this.callMatchContext(active, 'onLeave', session.playerId);
      if (session.activeMatchCtx === active) session.activeMatchCtx = null;
    }
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    if (this.matchQueueTimer) { clearInterval(this.matchQueueTimer); this.matchQueueTimer = null; }
    for (const entry of [...new Set(this.queueByPlayer.values())]) this.cancelMatchQueue(entry, reason);
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // restore (server/persist.js, docs/DEPLOY.md「断点续玩」)
  // ---------------------------------------------------------------------------------------------------

  /**
   * Rebuild the rooms of a persisted document. Seats whose session did not survive (or whose player had already left)
   * are dropped; a room without a human is not restored at all, and every restored seat starts disconnected with a
   * fresh lobby grace (the players are reconnecting right now).
   * @param {object[]} docs room documents (server/persist.js roomDoc)
   * @param {{ now?: number }} [opts]
   * @returns {{ rooms: number, seats: number, droppedSeats: number }}
   */
  restoreRooms(docs, { now = this.now() } = {}) {
    const stats = { rooms: 0, seats: 0, droppedSeats: 0 };
    for (const d of Array.isArray(docs) ? docs : []) {
      if (!d || typeof d.code !== 'string' || d.code.length !== ROOM_CODE_LEN || this.rooms.has(d.code)) { stats.droppedSeats++; continue; }
      const mode = d.mode === 'solo' ? 'solo' : 'coop';
      const difficulty = typeof d.difficulty === 'string' && d.difficulty ? d.difficulty : 'NORMAL';
      const room = new Room(d.code, mode, difficulty, now);
      room.ownerKey = typeof d.ownerKey === 'string' ? d.ownerKey : null;
      room.matchKey = typeof d.matchKey === 'string' ? d.matchKey : null;
      room.matchCount = Number.isInteger(d.matchCount) && d.matchCount >= 0 ? d.matchCount : 0;
      for (const s of Array.isArray(d.seats) ? d.seats : []) {
        if (!s || typeof s.playerId !== 'string' || !Number.isInteger(s.seat) || s.seat < 0 || s.seat >= MAX_SEATS || room.seats[s.seat]) continue;
        const isBot = !!s.isBot;
        const left = !!s.left;
        const session = isBot ? null : this.registry.byId(s.playerId);
        if (!isBot && !left && !session) { stats.droppedSeats++; continue; }
        room.seats[s.seat] = {
          seat: s.seat,
          playerId: s.playerId,
          name: session?.name || (typeof s.name === 'string' && s.name ? s.name : '博士'),
          isBot,
          ready: !!s.ready,
          connected: false,
          left,
          loadout: isBot ? null : (session?.loadout || (s.loadout && typeof s.loadout === 'object' ? s.loadout : null)),
        };
        stats.seats++;
      }
      if (room.activeHumans().length === 0) { stats.droppedSeats += room.seats.filter(Boolean).length; continue; }
      room.hostId = room.seatOf(d.hostId) ? d.hostId : null;
      if (!room.hostId) this.migrateHost(room);
      this.rooms.set(room.code, room);
      stats.rooms++;
      for (const s of room.seats) if (s && !s.isBot && !s.left && !s.connected) this.startGrace(room, s);
    }
    if (stats.rooms) this.log.info(`[lobby] restored ${stats.rooms} room(s), ${stats.seats} seat(s)${stats.droppedSeats ? `, ${stats.droppedSeats} seat(s) dropped` : ''}`);
    return stats;
  }

  /**
   * Rebuild a running match from a checkpoint (server/match/snapshot.js). Every seat of the checkpoint must still be in
   * the room; otherwise nothing is restored and the room stays in the lobby (the players simply start a new match).
   * @param {Room} room @param {object} checkpoint
   * @returns {boolean} true when the match runs again
   */
  restoreMatch(room, checkpoint) {
    if (!room || room.disposed || room.match || !checkpoint || typeof checkpoint !== 'object') return false;
    const players = Array.isArray(checkpoint.players) ? checkpoint.players : [];
    if (players.length === 0) return false;
    for (const p of players) {
      if (!p || typeof p.playerId !== 'string' || !Number.isInteger(p.seat)) return false;
      if (!room.seatOf(p.playerId)) return false;
    }
    const res = this.startMatchWith(room, room.matchKey, checkpoint);
    return !(res && res.error);
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  /**
   * Join the shared matchmaking pool. A player outside a room contributes one seat; a room host contributes the
   * whole connected party. `fillBots` controls whether other queued parties may be combined, while the 60 s deadline
   * always fills the remaining seats with AI as required by the game flow.
   */
  matchJoin(session, { mode, difficulty, fillBots = true }) {
    const room = this.roomOf(session);
    const active = this.activeMatchOf(session);
    if (active) return fail(ERR.ROOM_STARTED, 'match already running');
    if (this.queueByPlayer.has(session.playerId)) return fail(ERR.MATCHING);
    if (mode === 'solo') {
      if (room) return fail(ERR.MATCHING, 'leave the room before solo matchmaking');
      // Compatibility for clients from the first queue rollout. The current UI keeps independent simulation on its
      // solo room path and only sends mode=coop from the in-room teammate-match option.
      const entry = this.makeQueueEntry({ mode: 'coop', difficulty, fillBots: true, room: null,
        players: [{ seat: 0, playerId: session.playerId, name: session.name, isBot: false, connected: session.connected, loadout: session.loadout || null }] });
      this.enqueueMatchEntry(entry);
      this.processMatchQueues();
      return OK;
    }
    if (room) {
      if (room.match || room.matching) return fail(room.match ? ERR.ROOM_STARTED : ERR.MATCHING);
      if (room.mode !== 'coop') return fail(ERR.BAD_MSG, 'solo rooms cannot join co-op matchmaking');
      if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
      const humans = room.activeHumans();
      if (!humans.length || humans.some((s) => !s.connected)) return fail(ERR.NOT_READY, 'all party members must be connected');
      if (humans.some((s) => this.queueByPlayer.has(s.playerId))) return fail(ERR.MATCHING);
      const players = room.seats.filter(Boolean).map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name,
        isBot: !!s.isBot, connected: s.connected !== false, loadout: s.isBot ? null : s.loadout || null }));
      const entry = this.makeQueueEntry({ mode, difficulty: room.difficulty, fillBots: !!fillBots, room, players });
      this.enqueueMatchEntry(entry);
      this.broadcastState(room);
      this.processMatchQueues();
      return OK;
    }
    const entry = this.makeQueueEntry({ mode, difficulty, fillBots: true, room: null,
      players: [{ seat: 0, playerId: session.playerId, name: session.name, isBot: false, connected: session.connected, loadout: session.loadout || null }] });
    this.enqueueMatchEntry(entry);
    this.processMatchQueues();
    return OK;
  }

  matchLeave(session) {
    const entry = this.queueByPlayer.get(session.playerId);
    if (!entry) return fail(ERR.NOT_MATCHING);
    this.cancelMatchQueue(entry, 'cancelled');
    return OK;
  }

  makeQueueEntry({ mode, difficulty, fillBots, room, players }) {
    const now = this.now();
    const entry = {
      queueId: `Q${(++this.queueSeq).toString(36).toUpperCase()}`,
      mode, difficulty, fillBots: !!fillBots, room: room || null, players: players.map((p) => ({ ...p })),
      queuedAt: now, deadlineAt: now + Math.max(1000, Number(this.opts.matchmakingWaitMs) || 60_000),
      removed: false,
    };
    return entry;
  }

  enqueueMatchEntry(entry) {
    const key = `${entry.mode}:${entry.difficulty}`;
    const bucket = this.matchQueues.get(key) || [];
    bucket.push(entry);
    this.matchQueues.set(key, bucket);
    for (const p of entry.players) if (!p.isBot) {
      const session = this.registry.byId(p.playerId);
      if (session) session.matchQueue = entry;
      this.queueByPlayer.set(p.playerId, entry);
    }
    if (entry.room) {
      entry.room.matching = { queueId: entry.queueId, queuedAt: entry.queuedAt, deadlineAt: entry.deadlineAt, fillBots: entry.fillBots };
    }
    this.broadcastQueueCounts(entry.mode, entry.difficulty);
  }

  /** Send the current number of waiting human players to every ticket in one mode/difficulty bucket. */
  broadcastQueueCounts(mode, difficulty) {
    const bucket = this.matchQueues.get(`${mode}:${difficulty}`) || [];
    for (const entry of bucket) if (!entry.removed) this.sendQueueState(entry);
  }

  /** Process each bucket oldest-first. A complete four-person party starts immediately; the oldest incomplete ticket
   * receives AI at its deadline, so a quiet server never leaves an operator waiting indefinitely. */
  processMatchQueues() {
    const now = this.now();
    for (const [key, bucket] of this.matchQueues) {
      while (bucket.length) {
        const first = bucket[0];
        if (!first || first.removed) { bucket.shift(); continue; }
        const selected = [first];
        let total = first.players.length;
        if (first.fillBots) {
          for (let i = 1; i < bucket.length && total < MAX_SEATS; i++) {
            const next = bucket[i];
            if (!next || next.removed || !next.fillBots || total + next.players.length > MAX_SEATS) continue;
            selected.push(next);
            total += next.players.length;
          }
        }
        if (total < MAX_SEATS && now < first.deadlineAt) break;
        for (const entry of selected) {
          const idx = bucket.indexOf(entry);
          if (idx >= 0) bucket.splice(idx, 1);
          this.removeQueueReferences(entry);
        }
        this.broadcastQueueCounts(first.mode, first.difficulty);
        const players = selected.flatMap((entry) => entry.players.map((p) => ({ ...p })));
        while (players.length < MAX_SEATS) {
          const seat = players.length;
          players.push({ seat, playerId: `ai_${randomBytes(4).toString('hex')}`, name: BOT_NAMES[seat % BOT_NAMES.length],
            isBot: true, connected: true, loadout: null });
        }
        const owner = selected.find((entry) => entry.room) || first;
        this.startQueuedMatch(owner, players, selected);
      }
      if (!bucket.length) this.matchQueues.delete(key);
    }
  }

  removeQueueReferences(entry) {
    if (!entry || entry.removed) return;
    entry.removed = true;
    for (const p of entry.players) if (!p.isBot) {
      if (this.queueByPlayer.get(p.playerId) === entry) this.queueByPlayer.delete(p.playerId);
      const session = this.registry.byId(p.playerId);
      if (session?.matchQueue === entry) session.matchQueue = null;
    }
    if (entry.room && entry.room.matching?.queueId === entry.queueId) entry.room.matching = null;
  }

  cancelMatchQueue(entry, reason = 'cancelled') {
    if (!entry || entry.removed) return;
    const bucket = this.matchQueues.get(`${entry.mode}:${entry.difficulty}`);
    if (bucket) {
      const i = bucket.indexOf(entry);
      if (i >= 0) bucket.splice(i, 1);
      if (!bucket.length) this.matchQueues.delete(`${entry.mode}:${entry.difficulty}`);
    }
    this.removeQueueReferences(entry);
    this.sendQueueState(entry, reason === 'cancelled' ? 'cancelled' : 'closed', reason);
    this.broadcastQueueCounts(entry.mode, entry.difficulty);
    if (entry.room && !entry.room.disposed) this.broadcastState(entry.room);
  }

  sendQueueState(entry, status = 'queued', reason = null) {
    const count = status === 'queued'
      ? (this.matchQueues.get(`${entry.mode}:${entry.difficulty}`) || [])
        .filter((queued) => !queued.removed)
        .reduce((n, queued) => n + queued.players.filter((p) => !p.isBot).length, 0)
      : entry.players.filter((p) => !p.isBot).length;
    const msg = { t: 'match.queue', status, queueId: entry.queueId, mode: entry.mode, difficulty: entry.difficulty,
      count, capacity: MAX_SEATS, queuedAt: entry.queuedAt,
      deadlineAt: entry.deadlineAt, fillBots: entry.fillBots, ...(reason ? { reason } : {}) };
    for (const p of entry.players) if (!p.isBot) {
      const session = this.registry.byId(p.playerId);
      if (session?.connected) sendSession(session, msg);
    }
  }

  create(session, { mode, difficulty }) {
    if (this.queueByPlayer.has(session.playerId)) return fail(ERR.MATCHING);
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) {
      // the global cap used to fail silently: a full server and a crash looked the same to the player (docs/DEPLOY.md §3.4)
      this.limitWarn(`room limit (${this.opts.maxRooms}) reached (global)`);
      return fail(ERR.INTERNAL, 'too many rooms');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  join(session, { code }) {
    if (this.queueByPlayer.has(session.playerId)) return fail(ERR.MATCHING);
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const queued = this.queueByPlayer.get(session.playerId);
    if (queued) {
      this.cancelMatchQueue(queued, 'cancelled');
      if (queued.room) this.removeMember(queued.room, session.playerId);
      return OK;
    }
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matching) return fail(ERR.MATCHING);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matching) return fail(ERR.MATCHING);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matching) return fail(ERR.MATCHING);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matching) return fail(ERR.MATCHING);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.matching) return fail(ERR.MATCHING);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const loadout = freezeLoadout(res.loadout);
    session.loadout = loadout;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.loadout = loadout;
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    return this.startMatchWith(room, key, null);
  }

  /**
   * Start a match, or rebuild one from a checkpoint (server/persist.js, docs/DEPLOY.md「断点续玩」).
   * A restored match re-enters the phase of its checkpoint (server/match/snapshot.js) instead of calling start(); its
   * battle ids continue above the interrupted ones. On a restore failure the room simply stays in the lobby.
   * @param {Room} room @param {string | null} key @param {object | null} checkpoint
   */
  startMatchWith(room, key, checkpoint) {
    const host = room.seatOf(room.hostId);
    if (host && !checkpoint) host.ready = true;
    const seats = checkpoint
      ? checkpoint.players.map((p) => ({
        seat: p.seat, playerId: p.playerId, name: p.name, isBot: !!p.isBot, connected: false,
        loadout: p.isBot ? null : (p.loadout || null),
      }))
      : room.seats.filter(Boolean).map((s) => ({
        seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
        // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
        loadout: s.isBot ? null : s.loadout || null,
      }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    const matchNo = checkpoint ? Math.max(1, room.matchCount) : room.matchCount + 1;
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    if (checkpoint && Number.isInteger(checkpoint.seed)) seed = checkpoint.seed >>> 0;
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo,
        data: this.safeData(),
        workerPool: this.workerPool,
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      if (checkpoint) {
        if (!applyMatchCheckpoint(match, checkpoint, { createRngFromState, log: this.log })) {
          this.log.warn(`[lobby] ${room.code} match checkpoint refused — the room stays in the lobby`);
          this.disposeMatchCtx(ctx);
          this.broadcastState(room);
          return fail(ERR.INTERNAL, 'match checkpoint refused');
        }
        room.match = match;
        room.matchCtx = ctx;
        room.matchKey = key;
        room.replay = null;
        this.log.info(`[lobby] ${room.code} match #${room.matchCount} restored (${room.mode}/${room.difficulty}, round ${match.round}, ${match.phase})`);
        this.broadcastState(room);
        return OK;
      }
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** Start a match created by the matchmaking queue. Room members keep their room; individual queue members do not
   * acquire one, so the result screen returns them to the public lobby. */
  startQueuedMatch(owner, players, selected = [owner]) {
    const room = owner?.room || null;
    if (room && (room.disposed || room.match)) return fail(ERR.ROOM_STARTED);
    const used = new Set();
    const seats = players.map((p, i) => {
      let seat = Number.isInteger(p.seat) && p.seat >= 0 && p.seat < MAX_SEATS && !used.has(p.seat) ? p.seat : -1;
      if (seat < 0) { for (let j = 0; j < MAX_SEATS; j++) if (!used.has(j)) { seat = j; break; } }
      used.add(seat);
      return { ...p, seat, connected: p.isBot ? true : p.connected !== false };
    }).sort((a, b) => a.seat - b.seat);
    const allHumanIds = seats.filter((p) => !p.isBot).map((p) => p.playerId);
    const ctx = { live: true, ended: false, disposed: false, queue: true, match: null, room, members: seats,
      lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    const matchCode = room?.code || `M${randomBytes(3).toString('hex').toUpperCase()}`;
    try {
      const match = new this.MatchClass({
        roomCode: matchCode,
        mode: owner.mode,
        difficulty: owner.difficulty,
        modeId: modeIdFor(owner.mode, owner.difficulty),
        seats,
        seed,
        matchNo: room ? room.matchCount + 1 : 1,
        data: this.safeData(), workerPool: this.workerPool, log: this.log, now: this.now,
        send: (playerId, msg) => (ctx.live ? this.queueMatchSend(ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.queueMatchBroadcast(ctx, msg); },
        onEnd: (summary) => this.onQueuedMatchEnd(ctx, summary),
      });
      ctx.match = match;
      for (const id of allHumanIds) {
        const session = this.registry.byId(id);
        if (session) session.activeMatchCtx = ctx;
      }
      if (room) {
        room.match = match;
        room.matchCtx = ctx;
        room.matchKey = this.registry.byId(room.hostId)?.limitKey || null;
        room.matchCount++;
        room.replay = null;
        this.broadcastState(room);
      }
      for (const entry of selected) this.sendQueueState(entry, 'matched');
      this.log.info(`[match] ${matchCode} matchmaking start (${owner.mode}/${owner.difficulty}, ${seats.length} seats${room ? `, room ${room.code}` : ''})`);
      match.start();
    } catch (e) {
      this.log.error(`[match] ${matchCode} matchmaking start failed`, e);
      for (const id of allHumanIds) {
        const session = this.registry.byId(id);
        if (session?.activeMatchCtx === ctx) session.activeMatchCtx = null;
      }
      if (room && room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; this.broadcastState(room); }
      this.disposeMatchCtx(ctx);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  queueMatchSend(ctx, playerId, msg) {
    if (!ctx || ctx.disposed) return false;
    const p = ctx.members.find((x) => x.playerId === playerId);
    if (!p || p.isBot || p.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || !session.connected || session.activeMatchCtx !== ctx) return false;
    if (msg?.t === 'm.result') ctx.results.set(playerId, encode(msg));
    return sendSession(session, msg);
  }

  queueMatchBroadcast(ctx, msg) {
    if (!ctx || ctx.disposed) return null;
    const data = encode(msg);
    if (data == null) return null;
    if (msg?.t === 'm.public') ctx.lastPublic = data;
    else if (msg?.t === 'm.result') ctx.sharedResult = data;
    for (const p of ctx.members) if (!p.isBot && !p.left) {
      const session = this.registry.byId(p.playerId);
      if (session?.connected && session.activeMatchCtx === ctx) sendRaw(session.ws, data, { droppable: isDroppable(msg) });
    }
    return data;
  }

  onQueuedMatchEnd(ctx, summary) {
    if (!ctx || ctx.ended || !ctx.live) return;
    const room = ctx.room;
    for (const p of ctx.members) if (!p.isBot) {
      const session = this.registry.byId(p.playerId);
      if (session?.activeMatchCtx === ctx) session.activeMatchCtx = null;
      if (!room && session) session.roomCode = null;
    }
    if (room) {
      // onMatchEnd owns the room replay/lobby transition and its exactly-once guard.
      this.onMatchEnd(room, ctx, summary);
      return;
    }
    ctx.ended = true;
    ctx.live = false;
    this.log.info(`[match] standalone matchmaking match ended (${ctx.members.length} seats)`);
    setImmediate(() => this.disposeMatchCtx(ctx));
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    const active = this.activeMatchOf(session);
    if (!room && active?.match) {
      this.callMatchContext(active, 'onReconnect', session.playerId);
      return;
    }
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const active = this.activeMatchOf(session);
    const room = this.roomOf(session);
    const match = active?.match || room?.match;
    if (!match) return room ? fail(ERR.WRONG_PHASE, 'no running match') : fail(ERR.NOT_IN_ROOM);
    if (msg.t === 'g.leave') {
      if (active?.queue && !room) this.leaveQueuedMatchPlayer(active, session.playerId);
      else if (active?.queue && room) this.removeMember(room, session.playerId);
      else this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (room && msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${(room?.code || active?.match?.roomCode || 'queue')} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      const matchLabel = room?.code || active?.match?.roomCode || 'queue';
      this.log.error(`[lobby] ${matchLabel} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${matchLabel} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Match context for both room-bound queue matches and standalone queue matches. */
  activeMatchOf(session) {
    const ctx = session?.activeMatchCtx;
    if (ctx && ctx.match && !ctx.disposed) return ctx;
    const room = session ? this.roomOf(session) : null;
    if (room?.match && room.matchCtx) return room.matchCtx;
    return null;
  }

  callMatchContext(ctx, method, ...args) {
    if (!ctx?.match) return undefined;
    const fn = ctx.match[method] || (method === 'onLeave' ? ctx.match.onDisconnect : null);
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(ctx.match, args); } catch (e) {
      this.log.error(`[lobby] ${ctx.match.roomCode || 'queue'} ${method} threw`, e);
      return undefined;
    }
  }

  leaveQueuedMatchPlayer(ctx, playerId) {
    this.callMatchContext(ctx, 'onLeave', playerId);
    const session = this.registry.byId(playerId);
    if (session?.activeMatchCtx === ctx) session.activeMatchCtx = null;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
      if (session?.activeMatchCtx === room.matchCtx) session.activeMatchCtx = null;
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    const data = encode(room.toState());
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
