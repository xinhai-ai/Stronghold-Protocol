// public/js/resources/store.js — the preload store: downloads the manifest's files into Cache Storage and reports what
// is already there (docs/ASSETS.md「Preload」).
//
// One cache (`CACHE_NAME`) holds every asset, whatever manifest it came from, and each file's *hash* decides whether the
// stored bytes are still current: an asset update re-downloads the changed files only (~310 MiB → a few MiB), and a
// re-run of the extraction or a redeploy with unchanged art costs nothing. The hashes of the stored files live in one
// index entry inside that cache, written as the run advances — an interrupted run keeps the progress it flushed.
//
// The page does the downloading (a plain `fetch` per file, stored with `cache.put`), so a page without a Service Worker
// still builds the cache and only *serving it from the cache* needs one. Files are fetched with `cache: 'no-store'` on
// purpose: they are stored in Cache Storage, and letting the HTTP cache keep a second copy would double the disk the
// browser needs (~250 MiB of art). Everything is injected (`caches`, `fetcher`) so this module is unit-testable.

import {
  CACHE_NAME, CACHE_PREFIX, CONTENT_HASH_RE, MAX_FILE_BYTES, TIER_ESSENTIAL, TIER_REST, RESOURCE_GROUPS, resourceGroup, resourceType, absoluteUrl, indexUrl, checkAbort, isQuotaError,
} from './common.js';
import { verifiedResourceBytes } from './integrity.js';

/** Files above this are downloaded one at a time (a 20 MiB Spine texture should not race three others). */
const BIG_FILE_BYTES = 4 << 20;
/** Failures kept for the UI (the count is always exact). */
const MAX_FAILURES = 10;
/** Successful files between two index writes (a flush is one put of a few KiB; 64 keeps an abort at ~1 % loss). */
const INDEX_FLUSH_EVERY = 64;
const SMALL_IMPORT_BYTES = 256 * 1024;
const IMPORT_BUFFER_BYTES = 4 * SMALL_IMPORT_BYTES;

/**
 * The 12-hex SHA-1 of a response body — the same digest the server puts in the manifest (tools/asset-hashes.mjs,
 * tools/local-extract/extract.py). WebCrypto has no streaming digest, so one file is read at a time (Big files go
 * through the single big-file lane, so at most one of them is ever in memory).
 * @param {Response} response
 * @param {{ consume?: boolean }} [opts]
 * @returns {Promise<string|null>} null when the browser cannot hash (no WebCrypto, an unreadable body)
 */
async function digestOf(response, { consume = false } = {}) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bits = await subtle.digest('SHA-1', await (consume ? response : response.clone()).arrayBuffer());
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch {
    return null;
  }
}

export class ResourceStore {
  /**
   * @param {{ files: { url: string, tier: number, size?: number, hash?: string }[], version: string, totalBytes?: number|null }} manifest
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
    this.cacheName = CACHE_NAME;
    /** @type {Promise<any> | null} */
    this.running = null;
    this.statusPromise = null;
  }

  /** Cache key (absolute URL) of a manifest entry. */
  keyOf(url) {
    return absoluteUrl(url, this.origin) || String(url);
  }

  /** read(file) returns bytes or a locally verified resource. Callers own the download lock. */
  async importFiles(files, { read, signal, onProgress } = {}) {
    const entries = async function* () {
      for await (const file of files) yield { files: [file], size: file.size, read: () => read(file) };
    };
    return this.importEntries(entries(), { signal, onProgress, concurrency: 1 });
  }

  /** Entries own their verifier so the producer can advance without sharing a mutable current-resource slot. */
  async importEntries(entries, { signal, onProgress, onDiagnostics, concurrency = 4 } = {}) {
    checkAbort(signal);
    if (this.running) throw new Error('请先暂停资源下载');
    const lanes = Number.isInteger(concurrency) ? Math.max(1, Math.min(4, concurrency)) : 4;
    const cache = await this.caches.open(this.cacheName);
    const index = await this.#readIndex(cache);
    const before = await this.status();
    const allowed = new Set(this.files);
    const groups = new Map(before.groups.map((group) => [group.id, group]));
    const byKey = new Map();
    for (const file of this.files) {
      if (!this.eligible(file)) continue;
      const key = this.keyOf(file.url);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(file);
    }
    let imported = 0;
    let processed = 0;
    let failed = false;
    let failure;
    let inFlightBytes = 0;
    let indexFlush = Promise.resolve();
    const pending = new Set();
    const timings = { cacheCheckMs: 0, cacheWriteMs: 0, cacheWriteCount: 0, indexWriteMs: 0, maxInFlight: 0, maxInFlightBytes: 0 };
    const started = performance.now();
    const fail = (err) => { if (!failed) { failed = true; failure = err; } };
    const check = () => { if (failed) throw failure; checkAbort(signal); };
    const writeIndex = async () => {
      const start = performance.now();
      try { await this.#writeIndex(cache, index.files, this.manifest.version); }
      finally { timings.indexWriteMs += performance.now() - start; }
    };
    // Update counters per completed key; publishing copies only the small category list, not the whole manifest.
    const getStatus = () => {
      const { present: _present, ...status } = before;
      return { ...status, groups: before.groups.map((group) => ({ ...group })) };
    };
    const markPresent = (key) => {
      if (before.present.has(key)) return;
      before.present.add(key);
      for (const file of byKey.get(key) || []) {
        before.count++;
        if (file.tier === TIER_ESSENTIAL) before.tier1Present++; else before.tier2Present++;
        const group = groups.get(resourceGroup(file));
        group.present++;
        if (Number.isSafeInteger(file.size)) { before.bytes += file.size; before.sized++; group.bytes += file.size; }
      }
      before.complete = before.wanted > 0 && before.count >= before.wanted;
    };
    const one = async (entry) => {
      check();
      for (const file of entry.files) {
        if (!allowed.has(file) || !this.eligible(file) || !CONTENT_HASH_RE.test(file.hash || '')) {
          throw new Error('资源缺少可校验的当前指纹');
        }
      }
      // ZIP entries, including skipped/already-cached ones, must verify before inspecting their cache destinations.
      const prepared = entry.verify ? await entry.verify() : null;
      let currentFile = entry.files[0];
      for (const file of entry.files) {
        currentFile = file;
        check();
        const key = this.keyOf(file.url);
        const cacheStart = performance.now();
        let current;
        try {
          const existing = before.present.has(key) ? await cache.match(key) : null;
          current = !!existing && await digestOf(existing, { consume: true }) === file.hash;
        } finally { timings.cacheCheckMs += performance.now() - cacheStart; }
        if (!current) {
          const data = prepared || await entry.read();
          const verifiedBytes = verifiedResourceBytes(data, file.hash);
          const bytes = verifiedBytes || data;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES
            || (file.size != null && bytes.byteLength !== file.size)
            || (entry.size != null && bytes.byteLength !== entry.size)) throw new Error(`资源大小无效：${file.url}`);
          if (!verifiedBytes) {
            const bits = await globalThis.crypto.subtle.digest('SHA-1', bytes);
            const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
            if (hash !== file.hash) throw new Error(`资源校验失败：${file.url}`);
          }
          check();
          const response = new Response(bytes, { headers: { 'Content-Type': resourceType(file.url), 'Content-Length': String(bytes.byteLength) } });
          const writeStart = performance.now();
          timings.cacheWriteCount++;
          try { await cache.put(key, this.storable(response)); }
          finally { timings.cacheWriteMs += performance.now() - writeStart; }
          // A put cannot be cancelled: always index successful writes, even when another lane has since failed.
          index.files[key] = file.hash;
          markPresent(key);
          imported++;
          if (imported % INDEX_FLUSH_EVERY === 0) {
            indexFlush = indexFlush.then(writeIndex);
            await indexFlush;
          }
        }
      }
      onProgress?.({ imported, processed: ++processed, file: currentFile, getStatus });
    };
    try {
      onProgress?.({ imported, processed, getStatus });
      for await (const entry of entries) {
        check();
        const size = Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : MAX_FILE_BYTES;
        const exclusive = size > SMALL_IMPORT_BYTES;
        while (pending.size && (exclusive || pending.size >= lanes || inFlightBytes + size > IMPORT_BUFFER_BYTES)) {
          await Promise.race(pending);
          check();
        }
        checkAbort(signal);
        inFlightBytes += size;
        const task = one(entry).catch(fail).finally(() => { pending.delete(task); inFlightBytes -= size; });
        pending.add(task);
        timings.maxInFlight = Math.max(timings.maxInFlight, pending.size);
        timings.maxInFlightBytes = Math.max(timings.maxInFlightBytes, inFlightBytes);
        if (exclusive) {
          await task;
          check();
        }
      }
    } catch (err) { fail(err); }
    await Promise.all(pending);
    try { checkAbort(signal); } catch (err) { fail(err); }
    try { await writeIndex(); } catch (err) { fail(err); }
    const report = { ...timings, durationMs: performance.now() - started, imported, processed, failed,
      errorName: failed ? failure?.name || 'Error' : '', stageTimeMode: 'sum-of-overlapping-operations',
      averageCacheWriteMs: timings.cacheWriteCount ? timings.cacheWriteMs / timings.cacheWriteCount : 0 };
    try { onDiagnostics?.(report); } catch { /* diagnostics must not affect verified imports */ }
    if (failed) throw failure;
    return { ...await this.status(), imported, timings: report };
  }

  /**
   * The hashes of what this cache holds: `<absolute url>` → hash. A missing or unreadable index means "nothing is
   * verified", i.e. every entry is fetched again — what the first run of this version and a cleared cache need.
   * @param {any} cache
   */
  async #readIndex(cache) {
    let doc = null;
    try {
      const res = await cache.match(indexUrl(this.origin));
      if (res) doc = await res.json();
    } catch { doc = null; }
    const files = doc && typeof doc === 'object' && doc.files && typeof doc.files === 'object' ? doc.files : null;
    return { manifest: typeof doc?.manifest === 'string' ? doc.manifest : '', files: files ? { ...files } : {} };
  }

  /** Write the index entry (the only synthetic entry of the cache; the worker never answers it: not /assets|/fonts). */
  async #writeIndex(cache, files, manifest) {
    const body = JSON.stringify({ version: 1, manifest: String(manifest || ''), files });
    await cache.put(indexUrl(this.origin), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    this.statusPromise = null;
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
   * What is already cached *and current*: `present` holds the absolute URLs whose stored bytes match the manifest's
   * hash, plus every counter the settings panel shows. An entry of another revision (or with no index record yet) does
   * not count, which is what makes the next run fetch it again.
   */
  async status() {
    if (!this.statusPromise) {
      const pending = this.#status().finally(() => { if (this.statusPromise === pending) this.statusPromise = null; });
      this.statusPromise = pending;
    }
    const status = await this.statusPromise;
    // Coalesce only in-flight reads. Each caller gets its own counters/set; later calls check real cache eviction.
    return { ...status, groups: status.groups.map((group) => ({ ...group })), present: new Set(status.present) };
  }

  async #status() {
    const started = performance.now();
    const cache = await this.caches.open(this.cacheName);
    let keysMs = 0;
    let indexMs = 0;
    const [keys, index] = await Promise.all([
      (async () => {
        const start = performance.now();
        try { return await cache.keys(); } finally { keysMs = performance.now() - start; }
      })(),
      (async () => {
        const start = performance.now();
        try { return await this.#readIndex(cache); } finally { indexMs = performance.now() - start; }
      })(),
    ]);
    const cached = new Set(keys.map((k) => k.url));
    const fresh = this.#fresh(cached, index);
    return { ...this.#tally(fresh), present: fresh,
      checkTimings: { statusMs: performance.now() - started, cacheKeysMs: keysMs, indexReadMs: indexMs } };
  }

  /** The subset of `cached` whose recorded hash equals the manifest's (an entry without a hash counts as current). */
  #fresh(cached, index) {
    const fresh = new Set();
    for (const f of this.files) {
      const key = this.keyOf(f.url);
      if (!cached.has(key)) continue;
      if (f.hash && index.files[key] !== f.hash) continue;
      fresh.add(key);
    }
    return fresh;
  }

  /** Caches of earlier builds this app wrote: their entries carry no hash record and are verified before being kept. */
  async #olderCaches() {
    const names = (await this.caches.keys()) || [];
    return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.cacheName);
  }

  /** Fetch a file and hand back a storable response (an opaque or empty or failed answer throws). */
  async #fetchStorable(url, signal) {
    const res = await this.fetcher(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal });
    if (res.type === 'opaque' || !res.body) throw new Error('响应不可读取（缺少 CORS 头或空响应）');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /**
   * Rescue a file from a cache of the previous layout instead of downloading it again: hash the stored bytes and, when
   * they are exactly the revision this manifest wants, move the entry into the current cache. A mismatching entry is
   * dropped (the caller downloads the right bytes next) so a stale copy can never shadow the fresh one.
   * @returns {Promise<boolean>} true when the file needed no network at all
   */
  async #adopt(file, cache, older) {
    if (!older.length || !file.hash || !CONTENT_HASH_RE.test(file.hash)) return false; // nothing to compare against
    const key = this.keyOf(file.url);
    for (const name of older) {
      const other = await this.caches.open(name);
      const hit = await other.match(key);
      if (!hit) continue;
      if ((await digestOf(hit)) === file.hash) {
        await cache.put(key, hit); // same bytes, now in the current cache…
        await other.delete(key); // …and gone from the old one: never two copies, never a stale shadow
        return true;
      }
      await other.delete(key);
      return false;
    }
    return false;
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
    let tier1Wanted = 0;
    let tier2Wanted = 0;
    const groups = Object.fromEntries(Object.entries(RESOURCE_GROUPS).map(([id, group]) => [id,
      { id, ...group, total: 0, wanted: 0, present: 0, bytes: 0, totalBytes: 0, unknownSize: 0 }]));
    for (const f of this.files) {
      const hit = present.has(this.keyOf(f.url));
      const group = groups[resourceGroup(f)];
      group.total++;
      if (f.tier === TIER_ESSENTIAL) tier1++; else tier2++;
      if (!this.eligible(f)) { skipped++; continue; }
      if (hit) { if (f.tier === TIER_ESSENTIAL) tier1Present++; else tier2Present++; }
      group.wanted++;
      if (Number.isSafeInteger(f.size)) group.totalBytes += f.size;
      else group.unknownSize++;
      if (hit) { group.present++; if (Number.isSafeInteger(f.size)) group.bytes += f.size; }
      if (f.tier === TIER_ESSENTIAL) tier1Wanted++; else tier2Wanted++;
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
      tier1Wanted,
      tier2Wanted,
      groups: Object.values(groups).filter((g) => g.total > 0),
      complete: wanted > 0 && count >= wanted,
    };
  }

  /**
   * Download every missing file (essential tier first). Aborting the signal stops within one file; single file failures
   * are collected instead, so one broken file cannot waste a whole run.
   * @param {{ signal?: AbortSignal, onProgress?: (p: any) => void, tiers?: number[], includeFile?: (file: any) => boolean }} [opts]
   */
  download({ signal, onProgress, tiers = [TIER_ESSENTIAL, TIER_REST], includeFile = () => true } = {}) {
    if (this.running) return this.running;
    const run = this.#download({ signal, onProgress, tiers, includeFile }).finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  async #download({ signal, onProgress, tiers, includeFile }) {
    const wanted = new Set(tiers);
    const cache = await this.caches.open(this.cacheName);
    const index = await this.#readIndex(cache);
    const start = await this.status();
    checkAbort(signal);
    const work = this.files.filter((f) => wanted.has(f.tier) && includeFile(f) && this.eligible(f) && !start.present.has(this.keyOf(f.url)));
    const groups = start.groups.map((group) => ({ ...group }));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    let done = start.count;
    let bytes = start.bytes;
    let sized = start.sized;
    let failed = 0;
    let tier1Done = start.tier1Present;
    let tier2Done = start.tier2Present;
    let pendingFlush = 0;
    // Migration and network traffic are reported separately: the panel says "整理已保存的资源" while nothing is fetched.
    let adopted = 0;
    let downloaded = 0;
    /** @type {{ url: string, message: string }[]} */
    const failures = [];
    let lastEmit = 0;
    // Exactly the counters of status(): the UI maps one shape for both, so a field can never be missing mid-run.
    const progress = (current = null) => ({
      phase: 'download', count: done, total: start.total, wanted: start.wanted, skipped: start.skipped,
      bytes, totalBytes: start.totalBytes, sized, sizedTotal: start.sizedTotal,
      tier1: start.tier1, tier1Present: tier1Done, tier2: start.tier2, tier2Present: tier2Done,
      tier1Wanted: start.tier1Wanted, tier2Wanted: start.tier2Wanted,
      groups: groups.map((group) => ({ ...group })),
      complete: false, failed, failures: failures.slice(), current, adopted, downloaded,
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
      // Caches of the pre-hash layout: their entries are verified (and moved) before anything is fetched.
      const older = await this.#olderCaches();
      const one = async (file) => {
        checkAbort(signal);
        const key = this.keyOf(file.url);
        try {
          if (await this.#adopt(file, cache, older)) adopted++;
          else {
            let res = await this.#fetchStorable(key, signal);
            // `cache: 'no-store'` bypasses the HTTP cache, not Cache Storage: a Service Worker of an older build may
            // answer this fetch out of its own cache (and a stale one at that). Verify the bytes against the manifest
            // hash and, when they disagree, ask again on a URL no cache entry can match — the worker matches full URLs.
            // If the second answer still disagrees the asset hashes are stale (tools/asset-hashes.mjs --check catches
            // that before a deploy): keep the bytes rather than failing the file, and record the manifest's hash.
            if (file.hash && CONTENT_HASH_RE.test(file.hash)) {
              const seen = await digestOf(res);
              if (seen && seen !== file.hash) {
                res = await this.#fetchStorable(`${key}${key.includes('?') ? '&' : '?'}sp=${file.hash}`, signal);
              }
            }
            await cache.put(key, this.storable(res));
            downloaded++;
          }
          // The file is current only once the index says so: a run stopped before its next flush re-fetches this one.
          if (file.hash) {
            index.files[key] = file.hash;
            if (++pendingFlush >= INDEX_FLUSH_EVERY) { pendingFlush = 0; await this.#writeIndex(cache, index.files, this.manifest.version); }
          }
          const group = groupsById.get(resourceGroup(file));
          group.present++;
          if (Number.isSafeInteger(file.size)) group.bytes += file.size;
          done++;
          start.present.add(key);
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
      try {
        await drain(small, this.smallLanes);
        await drain(big, this.bigLanes);
        checkAbort(signal);
      } finally {
        // Flush on every exit — an abort or a quota failure included: the files stored so far must count as current
        // next time. A failing write only costs re-downloading them.
        try { await this.#writeIndex(cache, index.files, this.manifest.version); } catch { /* out of storage: the run is already failing */ }
      }
    } else {
      checkAbort(signal);
    }
    const after = await this.status();
    const result = { ...after, phase: 'ready', failed, failures: failures.slice(), adopted, downloaded };
    onProgress?.(result);
    // Only a complete set may drop anything: a partial run never deletes files it did not replace.
    if (result.complete) await this.prune();
    return result;
  }
  /** Delete every cache this app owns, of every version — 「清理缓存」 in the settings panel. Never re-creates one. */
  async clear() {
    this.statusPromise = null;
    if (this.caches?.keys) {
      const names = await this.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => this.caches.delete(n)));
    }
    this.statusPromise = null;
    return { ...this.#tally(new Set()), present: new Set() };
  }

  /** Drop the caches of other versions (a new asset manifest frees the files of the previous one). */
  async pruneOld() {
    const names = (await this.caches.keys()) || [];
    const stale = names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.cacheName);
    await Promise.all(stale.map((n) => this.caches.delete(n)));
    return stale;
  }

  /**
   * Delete cached entries that the manifest no longer lists (a file that was renamed or dropped would otherwise sit in
   * the cache forever, and its index record with it). Older caches are only cleaned up once they held no serviceable
   * entry at all — i.e. after the migration of this run moved or dropped what it could.
   */
  async pruneStale() {
    const cache = await this.caches.open(this.cacheName);
    const wanted = new Set(this.files.map((f) => this.keyOf(f.url)));
    const indexKey = indexUrl(this.origin);
    const keys = await cache.keys();
    const doomed = keys.filter((k) => k.url !== indexKey && !wanted.has(k.url));
    if (!doomed.length) return 0;
    await Promise.all(doomed.map((k) => cache.delete(k)));
    const index = await this.#readIndex(cache);
    for (const k of doomed) delete index.files[k.url];
    await this.#writeIndex(cache, index.files, this.manifest.version);
    return doomed.length;
  }

  /**
   * Housekeeping after a complete run: other caches (the version-named layout of earlier builds) and the entries this
   * manifest dropped. `includeStale: false` is used from a download, where the cache was just brought up to date.
   */
  async prune(includeStale = true) {
    const caches = await this.pruneOld();
    const files = includeStale ? await this.pruneStale() : 0;
    return { caches, files };
  }
}
