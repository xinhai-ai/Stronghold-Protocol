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
  phase: match.phase,
  round: match.round,
  battleSeq: match._battleSeq,
  ended: !!match.ended,
  lastResultMsg: match.lastResultMsg || null,
  order: Array.isArray(match.order) ? match.order.map((p) => ({
    playerId: p.playerId, seat: p.seat, name: p.name, isBot: !!p.isBot, left: !!p.left, connected: !!p.connected,
  })) : [],
});

const emit = (event) => { try { parentPort.postMessage(event); } catch { /* parent is closing */ } };

function makeOptions(key, input) {
  const base = { ...(input || {}) };
  delete base.send;
  delete base.broadcast;
  delete base.onEnd;
  delete base.workerPool;
  delete base.log;
  delete base.now;
  base.log = quiet;
  base.send = (playerId, msg, encoded) => emit({ type: 'send', key, playerId, msg, encoded: encoded || null });
  base.broadcast = (msg) => emit({ type: 'broadcast', key, msg });
  base.onEnd = (summary) => emit({ type: 'end', key, summary, meta: metaOf(matchFor(key)) });
  return base;
}

function matchFor(key) {
  const m = matches.get(key);
  if (!m) throw new Error(`unknown match ${key}`);
  return m;
}

async function call(key, requestId, method, args = []) {
  const match = matchFor(key);
  let value;
  if (method === 'snapshot') value = snapshotMatch(match);
  else if (method === 'capture') value = captureMatch(match);
  else if (method === 'dispose') value = match.dispose?.();
  else {
    const fn = match[method];
    if (typeof fn !== 'function') throw new Error(`unknown Match method ${method}`);
    value = fn.apply(match, args);
  }
  if (value && typeof value.then === 'function') value = await value;
  emit({ type: 'result', requestId, value: value && typeof value === 'object' ? value : value ?? null, meta: metaOf(match), key });
}

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'init') {
      const key = String(message.key);
      const match = new Match(makeOptions(key, message.options));
      if (message.checkpoint) {
        const ok = restoreMatch(match, message.checkpoint, {
          createRngFromState, log: quiet, bestEffort: true, departedPlayerIds: message.departedPlayerIds || [],
        });
        if (!ok) throw new Error('match checkpoint refused');
      }
      matches.set(key, match);
      emit({ type: 'ready', requestId: message.requestId, key, meta: metaOf(match) });
      return;
    }
    if (message.type === 'call') {
      await call(String(message.key), message.requestId, message.method, message.args);
      return;
    }
    if (message.type === 'shutdown') {
      for (const match of matches.values()) { try { match.dispose?.(); } catch { /* ignore */ } }
      matches.clear();
      process.exit(0);
    }
  } catch (error) {
    emit({ type: 'error', requestId: message.requestId || null, key: message.key || null, error: String(error?.message || error) });
  }
});
