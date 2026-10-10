// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { performance } from 'node:perf_hooks';
import { parseBotRehearsal, parseCombat, parseVerify } from '../match/Match.js';
import { WS_DEFLATE_THRESHOLD } from './websocket.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, sendJsonBody, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby }} health
 */
export function healthReport({ startedAt, network, registry, lobby }, counters = lobby.stats(), build = buildTag()) {
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build,
    sockets: network.connectionCount, sessions: registry.size, ...counters,
  };
}

/** One bounded per-server snapshot. HTTP clients still receive no-store.
 * Room/queue topology changes invalidate it immediately; seat/match changes inside
 * existing rooms refresh within one second. Cheap counts and uptime remain current.
 * The monotonic expiry is independent of wall-clock corrections.
 */
export function createHealthBody(health, { now = () => performance.now(), maxAgeMs = 1000 } = {}) {
  const { network, registry, lobby } = health;
  const build = buildTag();
  let counters = null, expiresAt = -Infinity;
  let roomCount = -1, queueMatches = -1, queuedPlayers = -1;
  let body = null, sockets = -1, sessions = -1, uptimeSec = -1;
  return () => {
    const at = now();
    const rooms = lobby.rooms.size;
    const matches = lobby.activeQueueMatches.size;
    const queued = lobby.queueByPlayer.size;
    let changed = false;
    if (!counters || at >= expiresAt || rooms !== roomCount || matches !== queueMatches || queued !== queuedPlayers) {
      counters = lobby.stats();
      expiresAt = at + maxAgeMs;
      roomCount = rooms;
      queueMatches = matches;
      queuedPlayers = queued;
      changed = true;
    }
    const currentSockets = network.connectionCount;
    const currentSessions = registry.size;
    const currentUptime = Math.round((Date.now() - health.startedAt) / 1000);
    if (!body || changed || currentSockets !== sockets || currentSessions !== sessions || currentUptime !== uptimeSec) {
      const report = healthReport(health, counters, build);
      // Use the values already read, including one wall-clock sample for uptime.
      report.sockets = sockets = currentSockets;
      report.sessions = sessions = currentSessions;
      report.uptimeSec = uptimeSec = currentUptime;
      body = Buffer.from(JSON.stringify(report));
    }
    return body;
  };
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, serveApi = null, diagnostics = {}, log }) {
  const healthBody = createHealthBody(health);
  function serveHealth(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    sendJsonBody(req, res, 200, healthBody());
  }
  function failed(req, res, e) {
    log.error('[http] request failed', e);
    sendError(req, res, 500, '服务器内部错误 · Internal error');
  }

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (parts.rawPath === '/healthz') { serveHealth(req, res); return; }
    if (serveApi && await serveApi(req, res, parts.rawPath)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/metrics') {
      const { network, lobby } = health;
      const { persister, workerPool, matchWorkerPool, announcements, wsCompression, assetsCdn, dataCdn, serveStatic } = diagnostics;
      const socketUsage = network.usage();
      sendJson(req, res, 200, {
        ...healthReport(health),
        persist: persister ? { redis: true, writes: persister.writes, checkpoints: persister.checkpointKeys.size,
          snapshotBytes: persister.encoder.seed?.bytes.byteLength || 0, workerMemory: persister.encoder.memory } : null,
        workers: workerPool?.stats() || null,
        ...(matchWorkerPool ? { matchWorkers: matchWorkerPool.stats() } : {}),
        announcements: announcements.stats(),
        // rss is process-wide (all Workers); other counters describe this main thread, in bytes.
        memory: process.memoryUsage(),
        staticCache: serveStatic.cacheStats(),
        socketBuffers: network.bufferedBytes(),
        websocket: { compression: wsCompression, threshold: WS_DEFLATE_THRESHOLD,
          diagnostics: network.diagnostics.stats() },
        assetsCdn: assetsCdn || null,
        dataCdn: dataCdn || null,
        limits: {
          maxRooms: lobby.opts.maxRooms,
          maxRoomsPerAddr: lobby.opts.maxRoomsPerAddr,
          maxMatchesPerAddr: lobby.opts.maxMatchesPerAddr,
          maxConnections: network.opts.maxConnections,
          maxConnectionsPerAddr: network.opts.maxConnectionsPerAddr,
        },
        // The engine-side knobs that decide how much CPU a match costs (docs/DEPLOY.md §3.4): env-level truth, i.e.
        // what a match adopts when startServer/the lobby do not pass an explicit option.
        tuning: {
          combat: parseCombat(process.env.SP_COMBAT),
          verify: parseVerify(process.env.SP_VERIFY),
          botRehearsal: parseBotRehearsal(process.env.SP_BOT_REHEARSAL),
        },
        // How close the busiest client network is to a cap (docs/DEPLOY.md §3.4). No addresses: /metrics is public and
        // the refusal logs (`room limit (16) reached for <ip>`) already name the network when it matters.
        usage: {
          ...lobby.usage(),
          socketNetworks: socketUsage.networks,
          worstSockets: socketUsage.worstSockets,
          overSockets: socketUsage.overSockets,
        },
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    const url = req.url || '/';
    if (url.length <= MAX_URL_LENGTH && (url === '/healthz' || url.startsWith('/healthz?') || url.startsWith('/healthz#'))) {
      try { serveHealth(req, res); } catch (e) { failed(req, res, e); }
      return;
    }
    handleRequest(req, res).catch((e) => failed(req, res, e));
  };
}
