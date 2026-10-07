// Read-only public HTTP APIs. Project only documented fields, never session ids or private match data.
import { createHash } from 'node:crypto';
import { DIFFICULTY_NAMES, MAX_SEATS } from '../shared/constants.js';
import { clientAddress, limitKeyOf, TokenBucket } from './net.js';

export function roomStatus(room, serverNow) {
  if (!room || room.disposed) return null;
  const inMatch = !!room.match;
  // Read the last published frame: querying must not calculate a new match view or expose unbroadcast progress.
  const pub = inMatch && room.matchCtx?.lastPublic ? JSON.parse(room.matchCtx.lastPublic) : null;
  const players = new Map((pub?.players || []).map((p) => [p.playerId, p]));
  const capacity = room.mode === 'solo' ? 1 : MAX_SEATS;
  const seats = room.seats.slice(0, capacity).map((s) => {
    if (!s) return null;
    const p = players.get(s.playerId);
    return {
      seat: s.seat, name: s.name, isBot: !!s.isBot, isHost: s.playerId === room.hostId,
      connected: !!s.connected && !s.left, ready: p ? !!p.ready : !!s.ready,
      ...(p ? { alive: !!p.alive, lp: Number.isFinite(p.lp) ? p.lp : null,
        pendingLp: Number.isFinite(p.pendingLp) ? Math.max(0, p.pendingLp) : 0 } : {}),
    };
  });
  const occupied = seats.filter(Boolean).length;
  const humans = seats.filter((s) => s && !s.isBot).length;
  return {
    code: room.code, mode: room.mode, difficulty: room.difficulty,
    difficultyName: DIFFICULTY_NAMES[room.difficulty] || room.difficulty,
    inMatch, joinable: room.mode === 'coop' && !inMatch && occupied < capacity,
    capacity, occupied, humans, bots: occupied - humans,
    connectedHumans: seats.filter((s) => s && !s.isBot && s.connected).length,
    phase: inMatch ? pub?.phase || room.match.phase || 'LOBBY' : 'LOBBY',
    round: inMatch && Number.isFinite(pub?.round) ? pub.round : 0,
    lastRound: inMatch && Number.isFinite(pub?.lastRound) ? pub.lastRound : null,
    deadline: inMatch && Number.isFinite(pub?.deadline) ? pub.deadline : 0,
    paused: inMatch && !!pub?.paused, seats, serverNow,
  };
}

/** Returns true if this API router handled the request. Address resolution shares the WebSocket TRUST_PROXY rules. */
export function createPublicApi({ lobby, announcements, trustProxy, sendJson, sendError, now = Date.now }) {
  const buckets = new Map();
  let sweptAt = now();
  let announcementReadAt = now();
  return async (req, res, pathname) => {
    if (/^\/api\/rooms(?:\/|$)/i.test(pathname)) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      const at = now();
      if (at - sweptAt >= 60000) {
        for (const [key, bucket] of buckets) if (at - bucket.at >= 60000) buckets.delete(key);
        sweptAt = at;
      }
      const { ip } = clientAddress(req, trustProxy);
      // Unlike game admission, this query budget also applies to loopback and private networks.
      const key = limitKeyOf(ip);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = new TokenBucket(2, 10, at); buckets.set(key, bucket); }
      if (!bucket.take(at)) {
        res.setHeader('Retry-After', '1');
        sendJson(req, res, 429, { error: 'RATE_LIMITED' });
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
      } else {
        const match = /^\/api\/rooms\/([ABCDEFGHJKLMNPQRSTUVWXYZ]{4})\/status$/i.exec(pathname);
        const status = match ? roomStatus(lobby.getRoom(match[1]), at) : null;
        sendJson(req, res, status ? 200 : 404, status || { error: 'ROOM_NOT_FOUND' });
      }
      return true;
    }
    if (pathname === '/api/ping') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); }
      else if (req.method === 'GET' || req.method === 'HEAD') sendJson(req, res, 200, { ok: true });
      else {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
      }
      return true;
    }
    if (pathname === '/api/announcement' || pathname === '/api/popup-announcement') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
        return true;
      }
      // Reuse the existing schedule and reload at most once per second for HTTP readers.
      if (now() - announcementReadAt >= 1000) {
        announcementReadAt = now();
        await announcements.reload();
      } else if (announcements.pending) await announcements.pending;
      announcements.refresh();
      const serverTime = announcements.now();
      const popup = pathname === '/api/popup-announcement';
      const active = announcements.lastError ? null : popup ? announcements.popupCurrent : announcements.current;
      let announcement = null;
      if (active) {
        const content = { title: active.title || (popup ? '公告' : '维护公告'), text: active.text, expiresAt: active.endAt,
          ...(active.url ? { url: active.url } : {}),
          ...(typeof active.autoPopup === 'boolean' ? { autoPopup: active.autoPopup } : {}) };
        const id = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 24);
        announcement = { id, ...content };
      }
      sendJson(req, res, 200, { announcement, serverTime });
      return true;
    }
    return false;
  };
}
