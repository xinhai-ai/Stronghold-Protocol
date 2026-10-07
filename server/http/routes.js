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
import { parseBotRehearsal, parseCombat, parseVerify } from '../match/Match.js';
import { WS_DEFLATE_THRESHOLD } from './websocket.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby }} health
 */
export function healthReport({ startedAt, network, registry, lobby }) {
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
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
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (serveApi && await serveApi(req, res, parts.rawPath)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, healthReport(health));
      return;
    }
    if (parts.rawPath === '/metrics') {
      const { network, lobby } = health;
      const { persister, workerPool, announcements, wsCompression, assetsCdn, dataCdn, serveStatic } = diagnostics;
      const socketUsage = network.usage();
      sendJson(req, res, 200, {
        ...healthReport(health),
        persist: persister ? { redis: true, writes: persister.writes, checkpoints: persister.checkpointKeys.size,
          snapshotBytes: persister.encoder.seed?.bytes.byteLength || 0, workerMemory: persister.encoder.memory } : null,
        workers: workerPool?.stats() || null,
        announcements: announcements.stats(),
        // rss is process-wide (all Workers); other counters describe this main thread, in bytes.
        memory: process.memoryUsage(),
        staticCache: serveStatic.cacheStats(),
        socketBuffers: network.bufferedBytes(),
        websocket: { compression: wsCompression, threshold: WS_DEFLATE_THRESHOLD },
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
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
