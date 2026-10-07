// server/redis.js — the optional Redis connection that backs the server's state snapshots (docs/DEPLOY.md「断点续玩」).
//
// Redis is *optional*: without SP_REDIS_URL (or REDIS_URL) nothing here is constructed and the server stays exactly as
// it was — room and match state lives in memory only. With a URL the server keeps one JSON document (rooms, sessions,
// match checkpoints) under `<prefix>state`, refreshed by server/persist.js and read back once at boot.
//
// Failure policy: the game must never depend on Redis. A connection or command failure is logged (at most once per
// minute) and the caller keeps running; the next refresh tries again. Only `load()` is awaited at boot, with a short
// retry loop so a Redis that starts a moment after the game server still hands its state over.

import { createClient } from 'redis';

/** How long one connect attempt may take (ms). */
export const CONNECT_TIMEOUT_MS = 3000;
/** How long one command (GET/SET/DEL) may take before it is abandoned (ms). */
export const COMMAND_TIMEOUT_MS = 4000;
/** Boot-time load attempts and the pause between them (ms). */
export const LOAD_ATTEMPTS = 4;
export const LOAD_RETRY_MS = 750;
/** Failure log throttle (ms). */
const LOG_GAP_MS = 60_000;

/**
 * Read the Redis settings from the environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, prefix: string, ttlSec: number } | null} null = disabled
 */
export function parseRedisConfig(env = process.env) {
  const url = String(env.SP_REDIS_URL ?? env.REDIS_URL ?? '').trim();
  if (!url) return null;
  if (!/^rediss?:\/\//i.test(url) && !/^unix:/i.test(url)) return null;
  const rawPrefix = String(env.SP_REDIS_PREFIX ?? 'stronghold:').trim();
  const ttlRaw = Number(env.SP_REDIS_TTL);
  return {
    url,
    prefix: rawPrefix || 'stronghold:',
    ttlSec: Number.isFinite(ttlRaw) && ttlRaw >= 60 ? Math.trunc(ttlRaw) : 90_000, // 25 h: the longest reconnect window
  };
}

/** Minimal logger fallback (the server passes its own). */
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * One JSON document in Redis. `load()`/`save()` never throw.
 */
export class StateStore {
  /**
   * @param {{ url: string, prefix?: string, ttlSec?: number, name?: string, log?: object,
   *           connectTimeoutMs?: number, commandTimeoutMs?: number }} opts
   */
  constructor({ url, prefix = 'stronghold:', ttlSec = 90_000, name = 'state', log = noopLog,
    connectTimeoutMs = CONNECT_TIMEOUT_MS, commandTimeoutMs = COMMAND_TIMEOUT_MS }) {
    this.url = url;
    this.key = `${prefix}${name}`;
    this.ttlSec = ttlSec;
    this.connectTimeoutMs = Number.isFinite(connectTimeoutMs) ? Math.max(0, Number(connectTimeoutMs)) : CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = Number.isFinite(commandTimeoutMs) ? Math.max(0, Number(commandTimeoutMs)) : COMMAND_TIMEOUT_MS;
    this.log = log;
    /** @type {import('redis').RedisClientType | null} */
    this.client = null;
    /** @type {Promise<any> | null} */
    this.pending = null;
    this.lastErrorAt = -Infinity;
    this.lastErrorMsg = '';
    this.failures = 0;
    this.saved = 0;
    this.loadedAt = 0;
    this.loadState = 'unread';
    this.closed = false;
  }

  /** A safe label for logs (never the credential part of the URL). */
  get label() {
    try {
      const u = new URL(this.url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return 'redis';
    }
  }

  #warn(msg, err) {
    this.failures++;
    const now = Date.now();
    this.lastErrorMsg = err ? String(err.message || err) : msg;
    if (now - this.lastErrorAt < LOG_GAP_MS) return;
    this.lastErrorAt = now;
    this.log.warn(`[redis] ${msg} (${this.label}): ${this.lastErrorMsg} — running without persistence, retrying`);
  }

  /**
   * Connect (idempotent, never throws, never hangs). Returns the client when it is ready.
   * The attempt itself is bounded: node-redis keeps retrying per its reconnect strategy, which would otherwise leave
   * the caller waiting forever when the address simply does not answer (the game must keep running without Redis).
   * @returns {Promise<import('redis').RedisClientType | null>}
   */
  async connect() {
    if (this.closed) return null;
    if (this.client?.isReady) return this.client;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (this.client && !this.client.isOpen) { try { this.client.destroy(); } catch { /* ignore */ } this.client = null; }
      if (!this.client) {
        const client = createClient({
          url: this.url,
          socket: {
            connectTimeout: this.connectTimeoutMs > 0 ? this.connectTimeoutMs : CONNECT_TIMEOUT_MS,
            reconnectStrategy: (retries) => Math.min(200 + retries * 250, 3000),
          },
        });
        client.on('error', (e) => this.#warn('connection error', e));
        this.client = client;
      }
      const attempt = this.client.connect().then(() => 'ok', (e) => { this.#warn('connect failed', e); return 'error'; });
      const outcome = this.connectTimeoutMs > 0
        ? await Promise.race([attempt, timeoutValue(this.connectTimeoutMs, 'timeout')])
        : await attempt;
      if (outcome !== 'ok') {
        if (outcome === 'timeout') this.#warn(`connect timed out after ${this.connectTimeoutMs} ms`);
        this.#drop();
        return null;
      }
      this.log.info(`[redis] connected to ${this.label} (key ${this.key}, ttl ${this.ttlSec}s)`);
      return this.client;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Bound one command; a Redis that answers the handshake but never replies must not hold the save loop. */
  async #command(promise, label) {
    if (!(this.commandTimeoutMs > 0)) return promise;
    const timer = timeoutReject(this.commandTimeoutMs, new Error(`${label} timed out after ${this.commandTimeoutMs} ms`));
    try {
      return await Promise.race([promise, timer.promise]);
    } finally {
      timer.clear();
    }
  }

  #drop() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try { c.destroy(); } catch { /* ignore */ }
  }

  /**
   * Read the state document. Retries a few times at boot so a Redis that comes up after the game server still counts.
   * @param {{ attempts?: number, retryMs?: number }} [opts]
   * @returns {Promise<object | null>} the parsed document (null when absent/unavailable/malformed)
   */
  async load({ attempts = LOAD_ATTEMPTS, retryMs = LOAD_RETRY_MS } = {}) {
    this.loadState = 'unavailable';
    for (let i = 0; i < Math.max(1, attempts); i++) {
      const client = await this.connect();
      if (!client) {
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, retryMs).unref?.());
        continue;
      }
      try {
        const raw = await this.#command(client.get(this.key), 'read');
        if (raw == null) { this.loadState = 'empty'; return null; }
        const doc = JSON.parse(raw);
        this.loadedAt = Date.now();
        this.loadState = doc && typeof doc === 'object' ? 'loaded' : 'invalid';
        return this.loadState === 'loaded' ? doc : null;
      } catch (e) {
        this.loadState = e instanceof SyntaxError ? 'invalid' : 'unavailable';
        this.#warn('read failed', e);
        return null;
      }
    }
    return null;
  }

  /**
   * Write the state document (JSON, TTL-refreshed). Never throws.
   * @param {object} doc
   * @returns {Promise<boolean>}
   */
  async save(doc) {
    let json;
    try {
      json = JSON.stringify(doc);
    } catch (e) {
      this.#warn('state is not JSON-serializable', e);
      return false;
    }
    return this.saveSerialized(json);
  }

  /** JSON encoded by the persistence Worker; sending these bytes performs no main-thread JSON serialization. */
  async saveSerialized(json) {
    const client = await this.connect();
    if (!client) return false;
    try {
      await this.#command(client.set(this.key, json, { EX: this.ttlSec }), 'write');
      this.saved++;
      return true;
    } catch (e) {
      this.#warn('write failed', e);
      if (!this.client?.isReady) this.#drop();
      return false;
    }
  }

  /** Remove the state (used by tests and by `--reset-state`). */
  async clear() {
    const client = await this.connect();
    if (!client) return false;
    try { await this.#command(client.del(this.key), 'delete'); return true; } catch (e) { this.#warn('delete failed', e); return false; }
  }

  /** Close the connection (graceful: a pending command still lands). */
  async close() {
    this.closed = true;
    const c = this.client;
    this.client = null;
    if (!c) return;
    try { await c.close(); } catch { try { c.destroy(); } catch { /* ignore */ } }
  }
}

/** A promise that resolves to `value` after `ms` (unref'd: never keeps the process alive). */
function timeoutValue(ms, value) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    t.unref?.();
  });
}

/** A promise that rejects after `ms`, with the means to cancel it. */
function timeoutReject(ms, error) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
    timer.unref?.();
  });
  return { promise, clear: () => { if (timer) clearTimeout(timer); } };
}

/**
 * Open the store described by the environment, or null when Redis is not configured.
 * @param {{ env?: Record<string, string | undefined>, log?: object, name?: string }} [opts]
 * @returns {StateStore | null}
 */
export function openStoreFromEnv({ env = process.env, log = noopLog, name = 'state' } = {}) {
  const cfg = parseRedisConfig(env);
  if (!cfg) return null;
  return new StateStore({ ...cfg, name, log });
}
