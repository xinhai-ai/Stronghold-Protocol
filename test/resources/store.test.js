// test/resources/store.test.js — the Cache Storage downloader (public/js/resources/store.js) and the Service Worker
// handler (public/js/resources/service.js, docs/ASSETS.md「Preload」).
//
// Cache Storage and fetch are injected: a tiny in-memory cache plus a scripted fetcher, so the tests describe exactly
// what the browser would do (order, skipping, pauses, quota) without a browser and without megabytes of fixtures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, CACHE_PREFIX, cacheName, indexUrl, rangeResponse } from '../../public/js/resources/common.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { handleResourceRequest } from '../../public/js/resources/service.js';

/** Minimal Cache Storage (Cache API surface the store uses: open/keys/delete + cache.put/match/keys). */
class MemoryCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, response.clone()); }
  async match(request) { const hit = this.entries.get(typeof request === 'string' ? request : request.url); return hit ? hit.clone() : undefined; }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(request) { return this.entries.delete(typeof request === 'string' ? request : request.url); }
}
class MemoryCaches {
  constructor() { this.map = new Map(); }
  async open(name) { if (!this.map.has(name)) this.map.set(name, new MemoryCache()); return this.map.get(name); }
  async keys() { return [...this.map.keys()]; }
  async delete(name) { return this.map.delete(name); }
  async match(url) { for (const c of this.map.values()) { const hit = await c.match(url); if (hit) return hit; } return undefined; }
}

const ORIGIN = 'https://game.example';

function manifest(files, over = {}) {
  // Every file carries a hash unless the test says otherwise (`hash: null` is the pre-hash manifest).
  const all = files.map((f, i) => (f.hash !== undefined ? f : { ...f, hash: `h${i}` }));
  const totalBytes = all.reduce((n, f) => n + (Number.isSafeInteger(f.size) ? f.size : 0), 0);
  const sized = all.filter((f) => Number.isSafeInteger(f.size)).length;
  return { format: 1, version: 'v1', count: all.length, tier1: all.filter((f) => f.tier === 1).length, sized, totalBytes: sized ? totalBytes : null, files: all, ...over };
}

/**
 * Put a file into the preload cache the way a finished run leaves it: the body plus its hash in the index. A file
 * without a hash (an older manifest) needs no index record.
 */
async function seed(caches, url, body, hash) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, new Response(body));
  if (hash) {
    const res = await cache.match(indexUrl(ORIGIN));
    const doc = res ? await res.json() : { version: 1, manifest: '', files: {} };
    doc.files[url] = hash;
    await cache.put(indexUrl(ORIGIN), new Response(JSON.stringify(doc)));
  }
  return cache;
}

/** The hash the server writes for these bytes (12 hex of a SHA-1): the store verifies cached entries against it. */
async function digest(body) {
  const bits = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** A fetcher that answers every URL with `body.length` bytes and records the call order. */
function fetcherFor({ bodies = {}, fail = [], opaque = [], gzip = [], onCall } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    onCall?.(url, opts);
    if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (fail.includes(url)) throw new Error('HTTP 404');
    const body = bodies[url] ?? 'x'.repeat(8);
    if (opaque.includes(url)) return { type: 'opaque', ok: true, status: 200, body: null, headers: new Headers() };
    // a gzipped transfer: fetch hands over the DECODED body while Content-Length describes the compressed bytes
    if (gzip.includes(url)) return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': '42' } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) } });
  };
  return { fetch, calls };
}

const store = (m, extra = {}) => new ResourceStore(m, { caches: extra.caches ?? new MemoryCaches(), fetcher: extra.fetch, origin: ORIGIN, smallLanes: extra.smallLanes ?? 4, bigLanes: extra.bigLanes ?? 1, now: extra.now });

describe('ResourceStore', () => {
  test('status reports what is cached, in files and bytes', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 10 }, { url: '/assets/b.png', tier: 2, size: 20 }, { url: '/assets/c.png', tier: 2, size: 30 }]);
    const caches = new MemoryCaches();
    const s = store(m, { caches });
    const empty = await s.status();
    assert.deepEqual([empty.count, empty.total, empty.bytes, empty.complete, empty.tier1, empty.tier1Present], [0, 3, 0, false, 1, 0]);
    await seed(caches, `${ORIGIN}/assets/a.png`, '0123456789', 'h0');
    const one = await s.status();
    assert.deepEqual([one.count, one.bytes, one.tier1Present, one.complete], [1, 10, 1, false]);
    // …and a cached file of another revision does not count as current
    await seed(caches, `${ORIGIN}/assets/b.png`, 'stale-bytes', 'an-old-digest');
    const stale = await s.status();
    assert.deepEqual([stale.count, stale.complete], [1, false], 'the cached bytes belong to an older revision');
  });

  test('downloads the essential tier first, then the rest, skipping what is cached', async () => {
    const m = manifest([
      { url: '/assets/ui/a.png', tier: 1, size: 8 },
      { url: '/assets/avatar/b.png', tier: 1, size: 8 },
      { url: '/assets/spine/c.skel', tier: 2, size: 8 },
      { url: '/assets/spine/d.png', tier: 2, size: 8 },
    ]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/avatar/b.png`, 'cached!!', 'h1');
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const seen = [];
    const res = await s.download({ onProgress: (p) => seen.push(p) });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`, `${ORIGIN}/assets/spine/c.skel`, `${ORIGIN}/assets/spine/d.png`], 'cached file skipped, essential first');
    assert.equal(res.complete, true);
    assert.deepEqual([res.count, res.total, res.bytes, res.totalBytes, res.failed], [4, 4, 32, 32, 0]);
    assert.equal(seen.at(-1).complete, true);
    assert.equal(seen.at(-1).count, 4);
    // every progress payload carries the same counters as status(): the panel must never read an undefined field
    for (const p of seen) {
      for (const k of ['count', 'total', 'wanted', 'bytes', 'skipped', 'sized', 'sizedTotal', 'tier1', 'tier1Present', 'tier2', 'tier2Present']) {
        assert.equal(typeof p[k], 'number', `progress.${k} while ${p.phase} (${JSON.stringify(p[k])})`);
      }
    }
    assert.equal(seen.at(-1).sizedTotal, 4, 'the manifest sized every file');
    assert.equal(seen.at(-1).count, 4);
    const cached = await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/spine/c.skel`);
    assert.equal(await cached.text(), 'x'.repeat(8));
    assert.equal(cached.headers.get('x-sp-resource'), '1', 'entries are marked as ours');
    assert.equal(cached.headers.get('accept-ranges'), 'bytes');
    assert.equal(cached.headers.get('content-length'), '8', 'an uncompressed response keeps its exact length');
  });

  test('a gzip response never keeps the compressed Content-Length (it would truncate the stored body)', async () => {
    const m = manifest([{ url: '/assets/spine/a.skel', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    const { fetch } = fetcherFor({ gzip: [`${ORIGIN}/assets/spine/a.skel`] });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.equal(res.failed, 0);
    const cached = await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/spine/a.skel`);
    assert.equal(cached.headers.get('content-length'), null, 'fetch reports the compressed size (42) for a longer body');
    assert.equal(cached.headers.get('content-encoding'), null, 'the stored body is already decoded');
    assert.equal(cached.headers.get('content-type'), 'application/octet-stream', 'the type still follows the file');
    assert.equal(await cached.text(), 'x'.repeat(8));
  });

  test('two passes (tiers) can be run one after the other, as the controller does', async () => {
    const m = manifest([{ url: '/assets/ui/a.png', tier: 1, size: 8 }, { url: '/assets/spine/b.skel', tier: 2, size: 8 }]);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { fetch });
    await s.download({ tiers: [1] });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`]);
    const rest = await s.download({ tiers: [2] });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`, `${ORIGIN}/assets/spine/b.skel`]);
    assert.equal(rest.complete, true);
  });

  test('a single failure is collected, not fatal; an opaque response is a failure too', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 1, size: 8 }, { url: '/assets/c.png', tier: 1, size: 8 }]);
    const { fetch } = fetcherFor({ fail: [`${ORIGIN}/assets/a.png`], opaque: [`${ORIGIN}/assets/b.png`] });
    const s = store(m, { fetch });
    const res = await s.download();
    assert.equal(res.failed, 2);
    assert.equal(res.count, 1);
    assert.equal(res.complete, false);
    assert.deepEqual(res.failures.map((f) => f.url), ['/assets/a.png', '/assets/b.png'], 'the manifest keeps the original URL');
    assert.match(res.failures[0].message, /404/);
    assert.match(res.failures[1].message, /CORS/);
  });

  test('an abort stops the run and keeps what was already stored', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    const ac = new AbortController();
    let seen = 0;
    const { fetch, calls } = fetcherFor({ onCall: () => { if (++seen > 3) ac.abort(); } });
    const s = store(manifest(files), { fetch, smallLanes: 1 });
    await assert.rejects(() => s.download({ signal: ac.signal }), (err) => err.name === 'AbortError');
    assert.ok(calls.length <= 5, `stopped early (${calls.length} requests)`);
    const st = await s.status();
    assert.ok(st.count >= 3 && st.count < 12, `kept the finished files (${st.count})`);
  });

  test('a quota failure is reported as such (the UI tells the player, it does not retry 4 000 times)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    const cache = await caches.open(CACHE_NAME);
    cache.put = async () => { const err = new Error('The quota has been exceeded.'); err.name = 'QuotaExceededError'; throw err; };
    const { fetch } = fetcherFor();
    const s = store(m, { caches, fetch });
    await assert.rejects(() => s.download(), (err) => err.name === 'QuotaExceededError');
  });

  test('files bigger than the cap are skipped, never fetched', async () => {
    const m = manifest([{ url: '/assets/small.png', tier: 1, size: 8 }, { url: '/assets/huge.png', tier: 2, size: 25 * 1024 * 1024 }]);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/small.png`]);
    assert.equal(res.skipped, 1);
    assert.equal(res.complete, true, 'the skipped file does not keep the preload incomplete');
  });

  test('progress is throttled but always ends with the final state', async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    let t = 0;
    const { fetch } = fetcherFor();
    const s = store(manifest(files), { fetch, smallLanes: 4, now: () => (t += 10) });
    const seen = [];
    const res = await s.download({ onProgress: (p) => seen.push(p) });
    assert.ok(seen.length < files.length, `throttled (${seen.length} updates for ${files.length} files)`);
    assert.equal(res.count, 30);
    assert.equal(seen[0].count, 0);
    assert.equal(seen.at(-1).phase, 'ready');
    assert.equal(seen.at(-1).count, res.count);
    assert.ok(seen.every((p, i) => i === 0 || p.count >= seen[i - 1].count), 'monotonic');
  });

  test('clear deletes every version, pruneOld only the stale ones', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('old'));
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/legacy.png`, new Response('pre-hash layout'));
    await (await caches.open(cacheName('v0'))).put(`${ORIGIN}/assets/removed.png`, new Response('ancient'));
    await caches.open('unrelated-cache');
    const s = store(m, { caches, fetch: fetcherFor().fetch });
    assert.deepEqual((await s.pruneOld()).sort(), [`${CACHE_PREFIX}v0`, `${CACHE_PREFIX}v1`].sort());
    assert.deepEqual(await caches.keys(), [CACHE_NAME, 'unrelated-cache']);
    const after = await s.clear();
    assert.deepEqual(await caches.keys(), ['unrelated-cache'], 'other caches of the origin are never touched');
    assert.equal(after.count, 0);
  });

  test('an unchanged manifest downloads nothing at all', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 2, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', 'h0');
    await seed(caches, `${ORIGIN}/assets/b.png`, 'bbb', 'h1');
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [], 'the hashes match: nothing is fetched');
    assert.equal(res.complete, true);
    assert.deepEqual([res.count, res.bytes], [2, 16]);
  });

  test('only the file whose hash changed is fetched again, and its bytes are replaced', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }, { url: '/assets/b.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'same-bytes', 'h0');
    await seed(caches, `${ORIGIN}/assets/b.png`, 'old-bytes', 'an-old-digest');
    const { fetch, calls } = fetcherFor({ bodies: { [`${ORIGIN}/assets/b.png`]: 'new-bytes' } });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/b.png`]);
    assert.equal(res.complete, true, 'the replaced file closes the set');
    const cache = await caches.open(CACHE_NAME);
    assert.equal(await (await cache.match(`${ORIGIN}/assets/b.png`)).text(), 'new-bytes');
    assert.equal(await (await cache.match(`${ORIGIN}/assets/a.png`)).text(), 'same-bytes', 'the current file is left alone');
    const index = await (await cache.match(indexUrl(ORIGIN))).json();
    assert.deepEqual(index.files, { [`${ORIGIN}/assets/a.png`]: 'h0', [`${ORIGIN}/assets/b.png`]: 'h1' });
  });

  test('a file the manifest dropped is pruned, index record included', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', 'h0');
    await seed(caches, `${ORIGIN}/assets/gone.png`, 'orphan', 'old');
    const s = store(m, { caches, fetch: fetcherFor().fetch });
    assert.deepEqual(await s.prune(), { caches: [], files: 1 });
    const cache = await caches.open(CACHE_NAME);
    assert.equal(await cache.match(`${ORIGIN}/assets/gone.png`), undefined);
    assert.equal(await cache.match(`${ORIGIN}/assets/a.png`) !== undefined, true, 'the listed file stays');
    const index = await (await cache.match(indexUrl(ORIGIN))).json();
    assert.deepEqual(Object.keys(index.files), [`${ORIGIN}/assets/a.png`]);
  });

  test('a manifest without hashes keeps the old rule: whatever is cached counts as current', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8, hash: null }, { url: '/assets/b.png', tier: 1, size: 8, hash: null }]);
    const caches = new MemoryCaches();
    await seed(caches, `${ORIGIN}/assets/a.png`, 'aaa', null);
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/b.png`]);
    assert.equal(res.complete, true);
  });

  test('a cache of the previous layout is migrated, not re-downloaded', async () => {
    const bodies = { '/assets/a.png': 'aaa-bytes', '/assets/b.png': 'bbb-bytes-longer' };
    const files = [];
    for (const [url, body] of Object.entries(bodies)) files.push({ url, tier: 1, size: body.length, hash: await digest(body) });
    const m = manifest(files);
    const caches = new MemoryCaches();
    const legacy = await caches.open(cacheName('v1')); // the pre-hash layout: no index, no recorded hashes
    for (const [url, body] of Object.entries(bodies)) await legacy.put(`${ORIGIN}${url}`, new Response(body));
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [], 'every file was verified against its hash and moved: no network at all');
    assert.equal(res.adopted, 2);
    assert.equal(res.downloaded, 0);
    assert.equal(res.complete, true);
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`)).text(), 'aaa-bytes');
    assert.deepEqual(await caches.keys(), [CACHE_NAME], 'the emptied old cache is dropped once the set is complete');
    // and the migrated set is simply current next time (the index was written as the files moved)
    const again = await store(manifest(files), { caches, fetch: fetcherFor().fetch }).download();
    assert.equal(again.complete, true);
    assert.equal(again.adopted, 0);
  });

  test('a stale entry in an old cache is dropped and fetched, never left to shadow the new file', async () => {
    const fresh = 'new-bytes';
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: fresh.length, hash: await digest(fresh) }]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('old-bytes'));
    const { fetch, calls } = fetcherFor({ bodies: { [`${ORIGIN}/assets/a.png`]: fresh } });
    const s = store(m, { caches, fetch });
    const res = await s.download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/a.png`], 'the stored bytes do not match the manifest hash');
    assert.deepEqual([res.adopted, res.downloaded], [0, 1]);
    assert.deepEqual(await caches.keys(), [CACHE_NAME], 'the stale copy went with the old cache');
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`)).text(), fresh);
  });

  test('a synthetic hash is never verified against cached bytes (there is nothing to compare)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8, hash: 'syn-07572a8a157e' }]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('whatever'));
    const { fetch, calls } = fetcherFor();
    const res = await store(m, { caches, fetch }).download();
    assert.deepEqual(calls, [`${ORIGIN}/assets/a.png`]);
    assert.equal(res.adopted, 0);
    assert.equal(res.downloaded, 1);
  });

  test('an interrupted run keeps the progress it flushed', async () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ url: `/assets/f${i}.png`, tier: 1, size: 8 }));
    const ac = new AbortController();
    let seen = 0;
    const { fetch } = fetcherFor({ onCall: () => { if (++seen > 66) ac.abort(); } });
    const caches = new MemoryCaches();
    const s = store(manifest(files), { caches, fetch, smallLanes: 1 });
    await assert.rejects(() => s.download({ signal: ac.signal }), (err) => err.name === 'AbortError');
    const st = await s.status();
    assert.ok(st.count >= 64 && st.count <= 66, `the index was flushed mid-run (${st.count} kept)`);
    const calls2 = fetcherFor().calls;
    const s2 = store(manifest(files), { caches, fetch: fetcherFor({ onCall: (u) => calls2.push(u) }).fetch });
    await s2.download();
    assert.ok(calls2.length <= 6, `the next run only fetches the remainder (${calls2.length})`);
  });

  test('a second download while one is running is the same promise (no double run)', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const { fetch, calls } = fetcherFor({ onCall: () => gate });
    const s = store(m, { fetch });
    const a = s.download();
    const b = s.download();
    assert.equal(a, b);
    release();
    const res = await a;
    assert.equal(calls.length, 1);
    assert.equal(res.count, 1);
  });
});

describe('the Service Worker handler', () => {
  const cached = async () => {
    const caches = new MemoryCaches();
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('0123456789', { headers: { 'Content-Type': 'image/png' } }));
    return caches;
  };

  test('serves a cached resource, with ranges', async () => {
    const caches = await cached();
    const full = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(full.status, 200);
    assert.equal(await full.text(), '0123456789');
    const part = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { headers: { Range: 'bytes=2-4' } }), { caches });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '234');
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  });

  test('a CDN URL is answered from the cache as well (the resource may live elsewhere)', async () => {
    const caches = new MemoryCaches();
    const url = 'https://cdn.example.com/static/assets/spine/x.skel';
    // a cache of the pre-hash layout: the worker serves from every cache this app wrote, so an update never blanks out
    await (await caches.open(cacheName('legacy'))).put(url, new Response('skel-bytes'));
    const res = await handleResourceRequest(new Request(url), { caches });
    assert.equal(await res.text(), 'skel-bytes');
  });

  test('the current cache wins over an older one (a migrated file is never shadowed by a stale copy)', async () => {
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('stale'));
    await (await caches.open(CACHE_NAME)).put(`${ORIGIN}/assets/a.png`, new Response('fresh'));
    const res = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(await res.text(), 'fresh');
  });

  test('anything that is not a cached resource is left to the network (null)', async () => {
    const caches = await cached();
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/missing.png`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/js/main.js`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/data/assets.json`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/api/hello`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/ws`), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { method: 'POST' }), { caches }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches: null }), null);
    const empty = new MemoryCaches();
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches: empty }), null);
    assert.equal(await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`, { headers: { Range: 'bytes=99-100' } }), { caches: await cached() }).then((r) => r.status), 416);
  });

  test('the cached entry survives a re-serve (a range reply never mutates the cache)', async () => {
    const caches = await cached();
    const hit = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(hit.headers.get('accept-ranges'), null, 'the stored response is served as stored');
    await rangeResponse(await (await caches.open(CACHE_NAME)).match(`${ORIGIN}/assets/a.png`), 'bytes=0-1');
    const again = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(await again.text(), '0123456789');
  });
});
