// Sensitive-lexicon Docker HTTP screening. Endpoint and cache stay on the server.
import { performance } from 'node:perf_hooks';
import { createJevNameModeration } from './jevNameModeration.js';
export { createJevNameModeration, JEV_ENDPOINT } from './jevNameModeration.js';
import { sanitizeName, TokenBucket } from './net.js';
import { NAME_MAX_LEN, ERR } from '../shared/constants.js';

// Server-controlled base URL, never accepted from a browser request.
export const DEFAULT_LEXICON_URL = 'http://127.0.0.1:8080';
export function lexiconEndpoint(raw = DEFAULT_LEXICON_URL) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('SP_NAME_MODERATION_URL must be an absolute HTTP(S) base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SP_NAME_MODERATION_URL must be HTTP(S), without credentials, query or fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/contains';
  return url.href;
}
// Fail open only for review failures; never cache an unreviewed fallback.
const unavailable = () => ({ allowed: true });

export function createNameModeration({ baseUrl = DEFAULT_LEXICON_URL,
  timeoutMs = 4500, fetchFn = globalThis.fetch, now = () => performance.now(),
  cacheMs = 300000, cacheLimit = 512, maxConcurrent = 8 } = {}) {
  const endpoint = lexiconEndpoint(baseUrl);
  const cache = new Map(), pending = new Map(), buckets = new Map();
  const globalBudget = new TokenBucket(20, 40, now());
  let stopped = false;
  const controllers = new Set();
  async function evaluate(name) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: name }) });
      if (!response.ok) return unavailable();
      const data = await response.json();
      if (controller.signal.aborted || stopped || typeof data?.contains !== 'boolean') return unavailable();
      const allowed = !data.contains;
      const result = allowed ? { allowed: true } : { allowed: false, code: ERR.NAME_REJECTED };
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(name, { result, until: now() + cacheMs });
      return result;
    } catch { return unavailable(); }
    finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); }
  }
  return {
    async check(raw, address = '?') {
      if (typeof raw !== 'string' || raw.length > NAME_MAX_LEN) return { allowed: false, code: ERR.BAD_MSG };
      const name = sanitizeName(raw);
      if (!name) return { allowed: false, code: ERR.BAD_MSG };
      if (stopped) return unavailable();
      const at = now();
      const cached = cache.get(name);
      if (cached && cached.until > at) return { ...cached.result };
      cache.delete(name);
      // Cache hits cost no API calls; misses share a bounded per-network and process-wide budget.
      for (const [key, entry] of buckets) if (at - entry.seen > 60000) buckets.delete(key);
      let entry = buckets.get(address);
      if (!entry) {
        if (buckets.size >= 2048) return unavailable();
        entry = { bucket: new TokenBucket(1, 5, at), seen: at }; buckets.set(address, entry);
      }
      entry.seen = at;
      if (!entry.bucket.take(at)) return unavailable();
      if (pending.has(name)) return { ...await pending.get(name) };
      if (pending.size >= maxConcurrent || !globalBudget.take(at)) return unavailable();
      const task = evaluate(name);
      pending.set(name, task);
      try { return { ...await task }; } finally { pending.delete(name); }
    },
    close() { stopped = true; for (const controller of controllers) controller.abort(); cache.clear(); buckets.clear(); },
  };
}

export function createCombinedNameModeration(reviewers, mode = 'both') {
  const active = reviewers.filter(Boolean);
  if (!active.length) return null;
  return {
    mode,
    async check(name, address) {
      return new Promise((resolve) => {
        let remaining = active.length;
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        for (const reviewer of active) {
          Promise.resolve().then(() => reviewer.check(name, address)).catch(() => ({ allowed: true })).then((result) => {
            if (result?.allowed !== true && [ERR.NAME_REJECTED, ERR.BAD_MSG].includes(result?.code)) finish(result);
            else if (--remaining === 0) finish({ allowed: true });
          });
        }
      });
    },
    close() { for (const reviewer of active) reviewer.close?.(); },
  };
}

export function nameModerationFromEnv(env = process.env) {
  const mode = env.SP_NAME_MODERATION || (env.SP_NAME_MODERATION_URL ? 'lexicon' : env.TYPESAFE_API_KEY ? 'jev' : 'off');
  if (mode === 'off') return null;
  if (!['lexicon', 'jev', 'both'].includes(mode)) throw new Error('SP_NAME_MODERATION must be lexicon, jev, both or off');
  const lexicon = ['lexicon', 'both'].includes(mode)
    ? createNameModeration({ baseUrl: env.SP_NAME_MODERATION_URL || DEFAULT_LEXICON_URL }) : null;
  const jev = ['jev', 'both'].includes(mode)
    ? createJevNameModeration({ apiKey: env.TYPESAFE_API_KEY, model: env.SP_NAME_MODERATION_MODEL || 'jev-latest',
      threshold: env.SP_NAME_MODERATION_THRESHOLD === undefined ? 0.5 : Number(env.SP_NAME_MODERATION_THRESHOLD) }) : null;
  return createCombinedNameModeration([lexicon, jev], mode);
}
