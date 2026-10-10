// Worker-side owner of complete Match instances.
//
// The parent owns sockets and the lobby directory. This thread owns timers, Match state, AI, views and the match
// lifecycle. Messages are serialized per match by the parent pool; callbacks are event messages back to the parent.
import { parentPort } from 'node:worker_threads';
import { getData, setData } from '../data.js';
import { serialize } from 'node:v8';

const matches = new Map();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sentMetadata = new WeakMap();
const PLAYER_META_KEYS = ['playerId', 'seat', 'name', 'isBot', 'left', 'connected'];
let sharedData = null;
let Match, createRngFromState, captureMatch, restoreMatch, snapshotMatch;

const metaOf = (match) => ({
  roomCode: match.roomCode,
  seed: match.seed,
  battlePrefix: match.battlePrefix,
  phase: match.phase,
  round: match.round,
  _battleSeq: match._battleSeq,
  ended: !!match.ended,
  lastResultMsg: match.lastResultMsg || null,
  ...(match.ended ? { public: match.publicView() } : {}),
  order: Array.isArray(match.order) ? match.order.map((p) => ({
    playerId: p.playerId, seat: p.seat, name: p.name, isBot: !!p.isBot, left: !!p.left, connected: !!p.connected,
  })) : [],
});

const emit = (event, transfer = []) => {
  try { parentPort.postMessage(event, transfer); return true; }
  catch (error) {
    // Never swallow an uncloneable command reply: answer with an error rather than timing out the whole lane.
    if (event.requestId) throw error;
    // Unsolicited callbacks are best effort while the parent is closing.
    return false;
  }
};

const sameOrder = (a, b) => Array.isArray(a) && a.length === b.length
  && a.every((player, i) => PLAYER_META_KEYS.every((key) => player[key] === b[i][key]));

function emitWithMetadata(event, match, full = false, transfer = []) {
  const previous = sentMetadata.get(match);
  const next = metaOf(match);
  const changes = {};
  for (const [key, value] of Object.entries(next)) {
    if (!full && previous && (key === 'order' ? sameOrder(previous.order, value) : previous[key] === value)) continue;
    changes[key] = value;
  }
  // Failed structured clones must not advance the metadata baseline.
  if (emit({ ...event, ...(Object.keys(changes).length ? { meta: changes } : {}) }, transfer)) sentMetadata.set(match, next);
}

function encodeMessage(msg) {
  try {
    const encoded = JSON.stringify(msg);
    return typeof encoded === 'string' ? encoded : null;
  } catch { return null; } // Keep the existing non-throwing send contract for malformed frames.
}

function makeOptions(key, instanceId, input, isReady) {
  const base = { ...(input || {}) };
  base.data = sharedData;
  delete base.send;
  delete base.broadcast;
  delete base.onEnd;
  delete base.workerPool;
  delete base.log;
  delete base.now;
  base.log = quiet;
  // Restore can legitimately finish a match before the parent has attached its context.
  // Its final public/result travel in ready metadata instead of premature callbacks.
  base.send = (playerId, msg, encoded) => {
    if (!isReady()) return;
    const json = encoded ?? encodeMessage(msg);
    emit({ type: 'send', key, instanceId, playerId,
      ...(json === null ? { msg, encoded: null } : { kind: msg.t, encoded: json }) });
  };
  base.broadcast = (msg) => {
    if (!isReady()) return;
    const json = encodeMessage(msg);
    emit({ type: 'broadcast', key, instanceId,
      ...(json === null ? { msg, encoded: null } : { kind: msg.t, encoded: json }) });
  };
  base.onEnd = (summary) => {
    if (isReady()) emitWithMetadata({ type: 'end', key, instanceId, summary }, matchFor(key, instanceId));
  };
  return base;
}

function matchFor(key, instanceId) {
  const entry = matches.get(instanceId);
  if (!entry || entry.key !== key) throw new Error(`unknown match ${key}`);
  return entry.match;
}

async function call(key, instanceId, requestId, method, args = []) {
  const match = matchFor(key, instanceId);
  let value;
  let transfer = [];
  if (method === 'snapshot') value = snapshotMatch(match);
  else if (method === 'capture') value = captureMatch(match);
  else if (method === 'captureBytes') {
    const capture = captureMatch(match);
    // Preserve Maps/undefined and the non-enumerable schedule side channel. Complex checkpoint encoding stays
    // in the dedicated persistence Worker. Use an owned allocation, never transfer a pooled Buffer's slab.
    value = capture ? Uint8Array.from(serialize(capture)) : null;
    if (value) transfer = [value.buffer];
  }
  else if (method === 'dispose') {
    try { value = match.dispose?.(); }
    finally { matches.delete(instanceId); }
  }
  else {
    const fn = match[method];
    if (typeof fn !== 'function') throw new Error(`unknown Match method ${method}`);
    value = fn.apply(match, args);
  }
  if (value && typeof value.then === 'function') value = await value;
  emitWithMetadata({ type: 'result', requestId, value: value && typeof value === 'object' ? value : value ?? null, key, instanceId }, match, false, transfer);
}

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'configure') {
      if (sharedData) throw new Error('match worker already configured');
      setData(message.data && typeof message.data === 'object' ? message.data : {});
      sharedData = getData();
      // Content modules and the Node simulation default must see this snapshot before they are imported.
      [{ Match }, { createRngFromState }, { captureMatch, restoreMatch, snapshotMatch }] = await Promise.all([
        import('../match/Match.js'), import('../sim/rng.js'), import('../match/snapshot.js'),
      ]);
      emit({ type: 'configured', requestId: message.requestId });
      return;
    }
    if (message.type === 'init') {
      if (!Match) throw new Error('match worker not configured');
      const key = String(message.key);
      const instanceId = message.instanceId;
      if (matches.has(instanceId)) throw new Error('match instance already initialized');
      let ready = false;
      const match = new Match(makeOptions(key, instanceId, message.options, () => ready));
      matches.set(instanceId, { key, match });
      try {
        if (message.checkpoint) {
          const ok = restoreMatch(match, message.checkpoint, {
            createRngFromState, log: quiet, bestEffort: true, departedPlayerIds: message.departedPlayerIds || [],
          });
          if (!ok) throw new Error('match checkpoint refused');
        }
        ready = true;
        emitWithMetadata({ type: 'ready', requestId: message.requestId, key, instanceId }, match, true);
      } catch (error) {
        try { match.dispose(); } finally { matches.delete(instanceId); }
        throw error;
      }
      return;
    }
    if (message.type === 'call') {
      await call(String(message.key), message.instanceId, message.requestId, message.method, message.args);
      return;
    }
    if (message.type === 'shutdown') {
      for (const { match } of matches.values()) { try { match.dispose?.(); } catch { /* ignore */ } }
      matches.clear();
      process.exit(0);
    }
  } catch (error) {
    emit({ type: 'error', requestId: message.requestId || null, key: message.key || null, instanceId: message.instanceId, error: String(error?.message || error) });
  }
});
