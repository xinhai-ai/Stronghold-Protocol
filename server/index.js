// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST 0.0.0.0, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the content packs (/packs/index.json, /packs/<id>/<file> — the registry is packs.js)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status, else static
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT / SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import { nameModerationFromEnv } from './nameModeration.js';
import { createNameModerationRoute } from './http/nameModeration.js';
import path from 'node:path';
import { parseAssetCdn, parseEnvLimit, parseWsCompression } from './http/config.js';
import { openStoreFromEnv } from './redis.js';
import { Persister, restoreServer, SAVE_MS } from './persist.js';
import { SimulationPool, workerSettings } from './workers/pool.js';
import { Announcements } from './announcements.js';
import { createPublicApi } from './publicApi.js';
import { sendJson, sendError } from './http/common.js';
export { parseAssetCdn, parseEnvLimit, parseWsCompression } from './http/config.js';
export { WS_DEFLATE_THRESHOLD } from './http/websocket.js';
export { rewriteAssetPaths } from '../shared/cdn.js';

import { getData, loadData } from './data.js';
import { ROOT, listenAddress, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { answerClientError } from './http/common.js';
import { lanUrls, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   nameModeration?: { check: Function, close?: Function } | null,
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, matchmakingWaitMs?: number, matchmakingTickMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   store?: object | null, resume?: boolean, saveMs?: number, assetsCdn?: string, dataCdn?: string,
 *   workers?: number, workerQueue?: number, workerTimeoutMs?: number, workerPool?: SimulationPool | null,
 *   announcementsFile?: string | null, announcementPollMs?: number, wsCompression?: boolean, clientBuild?: boolean,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const nameModeration = opts.nameModeration !== undefined ? opts.nameModeration : nameModerationFromEnv();
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);

  const clientBuild = opts.clientBuild ?? !process.argv.includes('--source-client');
  // assets CDN: a serving-time rewrite of the two manifests (docs/DEPLOY.md §3.2)
  const rawCdn = opts.assetsCdn != null ? opts.assetsCdn : (process.env.SP_ASSETS_CDN ?? process.env.ASSETS_CDN);
  const assetsCdn = parseAssetCdn(rawCdn);
  if (String(rawCdn ?? '').trim() && !assetsCdn) {
    log.warn(`[http] SP_ASSETS_CDN=${String(rawCdn).trim()} ignored: an http(s):// URL or a /path is required (docs/DEPLOY.md §3.2)`);
  }
  const rawDataCdn = opts.dataCdn != null ? opts.dataCdn : process.env.SP_DATA_CDN;
  const dataCdn = parseAssetCdn(rawDataCdn);
  if (String(rawDataCdn ?? '').trim() && !dataCdn) {
    log.warn(`[http] SP_DATA_CDN=${String(rawDataCdn).trim()} ignored: an http(s):// URL or a /path is required (docs/DEPLOY.md §3.2)`);
  }
  // Redis is optional: no SP_REDIS_URL / REDIS_URL and the server is exactly what it always was (in memory only)
  const store = opts.store !== undefined ? opts.store : openStoreFromEnv({ log });
  const saveMs = Number.isFinite(opts.saveMs) ? Number(opts.saveMs) : Number(process.env.SP_REDIS_SAVE_MS) || SAVE_MS;

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const workerConfig = workerSettings();
  for (const [option, key] of [['workers', 'size'], ['workerQueue', 'maxQueue'], ['workerTimeoutMs', 'timeoutMs']]) {
    if (opts[option] != null) workerConfig[key] = opts[option];
  }
  const ownsWorkerPool = opts.workerPool === undefined;
  if (!Number.isInteger(workerConfig.size) || workerConfig.size < 0 || workerConfig.size > 32) {
    throw new RangeError('workers must be 0..32');
  }
  const workerPool = ownsWorkerPool ? (workerConfig.size > 0 ? new SimulationPool({ data, ...workerConfig }) : null) : opts.workerPool;
  const { registry, lobby, network } = createSessionStack({ ...opts, nameModeration }, { data, log, workerPool });
  // Resume the last state before listening: every reconnecting client is recognized by its token right away.
  const persister = store ? new Persister({ store, registry, lobby, log, now: opts.now, saveMs }) : null;
  if (store && opts.resume !== false) {
    try {
      const doc = await store.load();
      if (doc) {
        const stats = restoreServer({ doc, registry, lobby, log, now: Date.now() });
        if (stats.ok) {
          await persister.seed(doc);
          log.info(`[persist] state loaded (${stats.sessions} session(s), ${stats.rooms} room(s), ${stats.matches} match(es), ${stats.expired} expired${stats.droppedSeats ? `, ${stats.droppedSeats} seat(s) dropped` : ''}${stats.deferredMatches ? `, ${stats.deferredMatches} checkpoint(s) retained` : ''})`);
        } else {
          persister.deferLoad();
          log.warn(`[persist] saved state could not be interpreted (${stats.reason}); writes deferred to preserve it`);
        }
      } else {
        if (['unavailable', 'invalid'].includes(store.loadState)) {
          persister.deferLoad();
          log.warn(`[persist] saved state ${store.loadState}; reads will be retried before any write`);
        } else log.info('[persist] no saved state in Redis — starting fresh');
      }
    } catch (e) {
      persister.deferLoad();
      log.warn('[persist] could not load the saved state; writes deferred until recovery can be retried', e);
    }
  }
  const wsCompression = opts.wsCompression != null ? !!opts.wsCompression : parseWsCompression(process.env.SP_WS_COMPRESSION);
  const announcementFile = opts.announcementsFile !== undefined ? opts.announcementsFile
    : (process.env.SP_ANNOUNCEMENTS_FILE || path.join(ROOT, 'config', 'announcements.json'));
  const announcements = new Announcements({ file: announcementFile ? path.resolve(announcementFile) : null,
    broadcast: (msg) => network.broadcast(msg), log, pollMs: opts.announcementPollMs });
  await announcements.start();
  log.info(`[names] moderation ${nameModeration ? `${nameModeration.mode || 'enabled'} enabled (fail open)` : 'OFF — set SP_NAME_MODERATION=lexicon, jev or both to enable'}`);
  const servePublicApi = createPublicApi({ lobby, announcements, trustProxy: network.opts.trustProxy, sendJson, sendError });

  const serveNameReview = createNameModerationRoute({ moderation: nameModeration, trustProxy: network.opts.trustProxy });
  const serveApi = async (req, res, pathname) => await serveNameReview(req, res, pathname) || await servePublicApi(req, res, pathname);

  // content packs (docs/PACKS.md): scanned now — the start log names them — and again whenever their folders change
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
  packs.refresh(true);
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log, cdnBase: assetsCdn, dataCdnBase: dataCdn, clientBuild });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag(ROOT, { clientBuild });

  const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby }, serveApi, diagnostics: { persister, workerPool, announcements, wsCompression, assetsCdn, dataCdn, serveStatic }, log }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, wsCompression, announcements });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    await announcements.stop();
    nameModeration?.close?.();
    network.close(); // stop heartbeat/sweep timers of the half-built server
    persister?.stop();
    await persister?.encoder.close();
    lobby.shutdown('shutdown');
    if (ownsWorkerPool) await workerPool?.close();
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  persister?.start();

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      network.beginShutdown();
      nameModeration?.close?.();
      lobby.stopMatchmaking();
      await announcements.stop();
      // the state (match checkpoints included) is written while the rooms still exist, then the rooms are disposed
      // (room.closed) and only then are the sockets closed (1001: clients should not auto-reconnect)
      if (persister) {
        const ok = await persister.shutdown('shutdown');
        log.info?.(`[persist] final state ${ok ? 'saved' : 'NOT saved (Redis unavailable)'}`);
      }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      if (ownsWorkerPool) await workerPool?.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
      try { await store?.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, packs, store: store || null, persister, workerPool, announcements, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
