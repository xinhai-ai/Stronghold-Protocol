// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, no per-message deflate → Network.handleConnection. Refused at the
//     upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS, send } from '../net.js';
import { Lobby, LOBBY_DEFAULTS } from '../lobby.js';
import { splitUrl } from './common.js';
import { parseBotRehearsal, parseCombat, parseVerify } from '../match/Match.js';
import { netOptionsFrom, lobbyOptionsFrom, parseEnvLimit, parseWsCompression } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;
export const WS_DEFLATE_THRESHOLD = 1024;
const perNetwork = (n) => Number.isFinite(n) && n > 0 ? String(n) : 'unlimited';

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, workerPool }) {
  const netOptions = netOptionsFrom(opts);
  const lobbyOptions = lobbyOptionsFrom(opts);
  // Limit overrides (docs/DEPLOY.md §3.4): an explicit startServer option wins, then the environment, then the code
  // default. `0` means unlimited for the per-network caps; an unparsable value warns and keeps the default (a typo
  // must not silently remove a protection).
  const envLimits = [
    [lobbyOptions, 'maxRooms', 'SP_MAX_ROOMS', LOBBY_DEFAULTS.maxRooms],
    [lobbyOptions, 'maxRoomsPerAddr', 'SP_MAX_ROOMS_PER_ADDR', LOBBY_DEFAULTS.maxRoomsPerAddr],
    [lobbyOptions, 'maxMatchesPerAddr', 'SP_MAX_MATCHES_PER_ADDR', LOBBY_DEFAULTS.maxMatchesPerAddr],
    [netOptions, 'maxConnections', 'SP_MAX_CONNECTIONS', NET_DEFAULTS.maxConnections],
    [netOptions, 'maxConnectionsPerAddr', 'SP_MAX_CONNECTIONS_PER_ADDR', NET_DEFAULTS.maxConnectionsPerAddr],
  ];
  for (const [target, key, env, fallback] of envLimits) {
    if (target[key] == null) target[key] = parseEnvLimit(process.env[env], fallback, env, log);
  }
  log.info(`[http] limits: rooms ${lobbyOptions.maxRooms} (${perNetwork(lobbyOptions.maxRoomsPerAddr)}/network), matches ${perNetwork(lobbyOptions.maxMatchesPerAddr)}/network, sockets ${netOptions.maxConnections} (${perNetwork(netOptions.maxConnectionsPerAddr)}/network)`);
  log.info(`[match] tuning: combat ${parseCombat(process.env.SP_COMBAT)}, verify ${parseVerify(process.env.SP_VERIFY)}, bot rehearsal ${parseBotRehearsal(process.env.SP_BOT_REHEARSAL)} (docs/DEPLOY.md §3.4)`);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions, workerPool });
  const network = new Network({ registry, handler: lobby, log, options: netOptions, nameModeration: opts.nameModeration });
  return { registry, lobby, network };
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, wsCompression = parseWsCompression(process.env.SP_WS_COMPRESSION), announcements = null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: wsCompression ? { threshold: WS_DEFLATE_THRESHOLD, serverNoContextTakeover: true, clientNoContextTakeover: true } : false, clientTracking: false });
  wss.on('connection', (ws, req) => { network.handleConnection(ws, req); if (announcements) { announcements.refresh(); send(ws, announcements.message()); send(ws, announcements.message('popup')); } });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
