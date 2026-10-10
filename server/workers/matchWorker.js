// Worker-side owner of complete Match instances.
//
// The parent owns sockets and the lobby directory. This thread owns timers, Match state, AI, views and the match
// lifecycle. Messages are serialized per match by the parent pool; callbacks are event messages back to the parent.
import { parentPort } from 'node:worker_threads';
import { Match } from '../match/Match.js';
import { createRngFromState } from '../sim/rng.js';
import { captureMatch, restoreMatch, snapshotMatch } from '../match/snapshot.js';

const matches = new Map();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

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

const emit = (event) => {
  try { parentPort.postMessage(event); }
  catch (error) {
    // Never swallow an uncloneable command reply: answer with an error rather than timing out the whole lane.
    if (event.requestId) throw error;
    // Unsolicited callbacks are best effort while the parent is closing.
  }
};

function makeOptions(key, instanceId, input, isReady) {
  const base = { ...(input || {}) };
  delete base.send;
  delete base.broadcast;
  delete base.onEnd;
  delete base.workerPool;
  delete base.log;
  delete base.now;
  base.log = quiet;
  // Restore can legitimately finish a match before the parent has attached its context.
  // Its final public/result travel in ready metadata instead of premature callbacks.
  base.send = (playerId, msg, encoded) => { if (isReady()) emit({ type: 'send', key, instanceId, playerId, msg, encoded: encoded || null }); };
  base.broadcast = (msg) => { if (isReady()) emit({ type: 'broadcast', key, instanceId, msg }); };
  base.onEnd = (summary) => { if (isReady()) emit({ type: 'end', key, instanceId, summary, meta: metaOf(matchFor(key, instanceId)) }); };
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
  if (method === 'snapshot') value = snapshotMatch(match);
  else if (method === 'capture') value = captureMatch(match);
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
  emit({ type: 'result', requestId, value: value && typeof value === 'object' ? value : value ?? null, meta: metaOf(match), key, instanceId });
}

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'init') {
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
        emit({ type: 'ready', requestId: message.requestId, key, instanceId, meta: metaOf(match) });
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
