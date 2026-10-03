// public/js/resources/store.js — the preload store: downloads the manifest's files into Cache Storage and reports what
// is already there (docs/ASSETS.md「Preload」).
//
// The page does the downloading (a plain `fetch` per file, stored with `cache.put`), so a page without a Service Worker
// still builds the cache and only *serving it from the cache* needs one. Files are fetched with `cache: 'no-store'` on
// purpose: they are stored in Cache Storage, and letting the HTTP cache keep a second copy would double the disk the
// browser needs (~250 MiB of art). Everything is injected (`caches`, `fetcher`) so this module is unit-testable.

import { CACHE_PREFIX, MAX_FILE_BYTES, TIER_ESSENTIAL, TIER_REST, absoluteUrl, cacheName, checkAbort, isQuotaError } from './common.js';

/** Files above this are downloaded one at a time (a 20 MiB Spine texture should not race three others). */
const BIG_FILE_BYTES = 4 << 20;
/** Failures kept for the UI (the count is always exact). */
const MAX_FAILURES = 10;

export class ResourceStore {
  /**
   * @param {{ files: { url: string, tier: number, size?: number }[], version: string, totalBytes?: number|null }} manifest
   * @param {{ caches?: any, fetcher?: typeof fetch, origin?: string, smallLanes?: number, bigLanes?: number,
   *           now?: () => number }} [opts]
   */
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis), origin, smallLanes = 4, bigLanes = 1, now = () => Date.now() } = {}) {
    this.manifest = manifest;
    this.files = Array.isArray(manifest.files) ? manifest.files : [];
    this.caches = caches;
    this.fetcher = fetcher;
    this.origin = origin || globalThis.location?.origin || 'http://localhost';
    this.smallLanes = Math.max(1, smallLanes);
    this.bigLanes = Math.max(1, bigLanes);
    this.now = now;
    this.cacheName = cacheName(manifest.version);
    /** @type {Promise<any> | null} */
    this.running = null;
  }

  /** Cache key (absolute URL) of a manifest entry. */
  keyOf(url) {
    return absoluteUrl(url, this.origin) || String(url);
  }

  /** A file this store will fetch: small enough to be worth caching (a huge one is skipped, never fails the run). */
  eligible(file) {
    return !(Number.isSafeInteger(file.size) && file.size > MAX_FILE_BYTES);
  }

  /** The response we store: original type, `Accept-Ranges` (the worker answers ranges) and our marker. */
  storable(response) {
    const headers = new Headers();
    const type = response.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    // A stored body must never claim a length it does not have: `fetch` hands us the DECODED body, so a compressed
    // transfer's Content-Length (372 for a 100 000-byte gzipped .skel) would describe the wrong bytes and the browser
    // would truncate it. Keep the header only when the response was not content-encoded — there it is exactly the
    // length we store (and DevTools' Cache Storage view can show a size instead of 0).
    if (!response.headers.get('content-encoding')) {
      const len = Number(response.headers.get('content-length'));
      if (Number.isSafeInteger(len) && len >= 0) headers.set('Content-Length', String(len));
    }
    headers.set('Accept-Ranges', 'bytes');
    headers.set('X-SP-Resource', '1');
    return new Response(response.body, { status: 200, statusText: 'OK', headers });
  }

  /**
   * What is already cached: `present` holds absolute URLs, plus every counter the settings panel shows. Entries of an
   * older manifest never count (the cache name carries the version).
   */
  async status() {
    const cache = await this.caches.open(this.cacheName);
    const present = new Set((await cache.keys()).map((k) => k.url));
    return { ...this.#tally(present), present };
  }

  /** Counters for a set of cached URLs (shared by status() and clear(), which must not re-create a cache). */
  #tally(present) {
    const total = this.files.length;
    let count = 0;
    let bytes = 0;
    let sized = 0;
    let skipped = 0;
    let tier1 = 0;
    let tier1Present = 0;
    let tier2 = 0;
    let tier2Present = 0;
    for (const f of this.files) {
      const hit = present.has(this.keyOf(f.url));
      if (f.tier === TIER_ESSENTIAL) { tier1++; if (hit) tier1Present++; } else { tier2++; if (hit) tier2Present++; }
      if (!this.eligible(f)) { skipped++; continue; }
      if (hit) {
        count++;
        if (Number.isSafeInteger(f.size)) { bytes += f.size; sized++; }
      }
    }
    const wanted = total - skipped;
    return {
      version: this.manifest.version,
      cacheName: this.cacheName,
      count,
      total,
      wanted,
      skipped,
      bytes,
      totalBytes: Number.isSafeInteger(this.manifest.totalBytes) ? this.manifest.totalBytes : null,
      sized,
      sizedTotal: Number.isSafeInteger(this.manifest.sized) ? this.manifest.sized : null,
      tier1,
      tier1Present,
      tier2,
      tier2Present,
      complete: wanted > 0 && count >= wanted,
    };
  }

  /**
   * Download every missing file (essential tier first). Aborting the signal stops within one file; single file failures
   * are collected instead, so one broken file cannot waste a whole run.
   * @param {{ signal?: AbortSignal, onProgress?: (p: any) => void, tiers?: number[] }} [opts]
   */
  download({ signal, onProgress, tiers = [TIER_ESSENTIAL, TIER_REST] } = {}) {
    if (this.running) return this.running;
    const run = this.#download({ signal, onProgress, tiers }).finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  async #download({ signal, onProgress, tiers }) {
    const wanted = new Set(tiers);
    const start = await this.status();
    checkAbort(signal);
    const work = this.files.filter((f) => wanted.has(f.tier) && this.eligible(f) && !start.present.has(this.keyOf(f.url)));
    let done = start.count;
    let bytes = start.bytes;
    let sized = start.sized;
    let failed = 0;
    let tier1Done = start.tier1Present;
    let tier2Done = start.tier2Present;
    /** @type {{ url: string, message: string }[]} */
    const failures = [];
    let lastEmit = 0;
    // Exactly the counters of status(): the UI maps one shape for both, so a field can never be missing mid-run.
    const progress = (current = null) => ({
      phase: 'download', count: done, total: start.total, wanted: start.wanted, skipped: start.skipped,
      bytes, totalBytes: start.totalBytes, sized, sizedTotal: start.sizedTotal,
      tier1: start.tier1, tier1Present: tier1Done, tier2: start.tier2, tier2Present: tier2Done,
      complete: false, failed, failures: failures.slice(), current,
    });
    const emit = (current = null, force = false) => {
      if (!onProgress) return;
      const t = this.now();
      if (!force && t - lastEmit < 120) return;
      lastEmit = t;
      onProgress(progress(current));
    };
    emit(null, true);
    if (work.length) {
      // the manifest is sorted essential-first, so a plain order keeps tier 1 ahead of tier 2
      const small = [];
      const big = [];
      for (const f of work) (Number.isSafeInteger(f.size) && f.size > BIG_FILE_BYTES ? big : small).push(f);
      const cache = await this.caches.open(this.cacheName);
      const one = async (file) => {
        checkAbort(signal);
        const key = this.keyOf(file.url);
        try {
          const res = await this.fetcher(key, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal });
          if (res.type === 'opaque' || !res.body) throw new Error('响应不可读取（缺少 CORS 头或空响应）');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await cache.put(key, this.storable(res));
          done++;
          if (file.tier === TIER_ESSENTIAL) tier1Done++; else tier2Done++;
          if (Number.isSafeInteger(file.size)) { bytes += file.size; sized++; }
        } catch (err) {
          checkAbort(signal); // an abort wins over a per-file error: the run is being stopped
          if (isQuotaError(err)) {
            const quota = new Error('quota exceeded');
            quota.name = 'QuotaExceededError';
            quota.cause = err;
            throw quota;
          }
          failed++;
          if (failures.length < MAX_FAILURES) failures.push({ url: file.url, message: String(err?.message || err) });
        }
        emit(file.url);
      };
      const drain = async (list, lanes) => {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(lanes, list.length) }, async () => {
          for (let i = next++; i < list.length; i = next++) await one(list[i]);
        }));
      };
      await drain(small, this.smallLanes);
      await drain(big, this.bigLanes);
    }
    checkAbort(signal);
    const after = await this.status();
    const result = { ...after, phase: 'ready', failed, failures: failures.slice() };
    onProgress?.(result);
    return result;
  }

  /** Delete every cache this app owns, of every version — 「清理缓存」 in the settings panel. Never re-creates one. */
  async clear() {
    if (this.caches?.keys) {
      const names = await this.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => this.caches.delete(n)));
    }
    return { ...this.#tally(new Set()), present: new Set() };
  }

  /** Drop the caches of other versions (a new asset manifest frees the files of the previous one). */
  async pruneOld() {
    const names = (await this.caches.keys()) || [];
    const stale = names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.cacheName);
    await Promise.all(stale.map((n) => this.caches.delete(n)));
    return stale;
  }
}
