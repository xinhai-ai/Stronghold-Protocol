// test/resources/store.test.js — the Cache Storage downloader (public/js/resources/store.js) and the Service Worker
// handler (public/js/resources/service.js, docs/ASSETS.md「Preload」).
//
// Cache Storage and fetch are injected: a tiny in-memory cache plus a scripted fetcher, so the tests describe exactly
// what the browser would do (order, skipping, pauses, quota) without a browser and without megabytes of fixtures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_PREFIX, cacheName, rangeResponse } from '../../public/js/resources/common.js';
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
  const totalBytes = files.reduce((n, f) => n + (Number.isSafeInteger(f.size) ? f.size : 0), 0);
  const sized = files.filter((f) => Number.isSafeInteger(f.size)).length;
  return { format: 1, version: 'v1', count: files.length, tier1: files.filter((f) => f.tier === 1).length, sized, totalBytes: sized ? totalBytes : null, files, ...over };
}

/** A fetcher that answers every URL with `body.length` bytes and records the call order. */
function fetcherFor({ bodies = {}, fail = [], opaque = [], onCall } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    onCall?.(url, opts);
    if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (fail.includes(url)) throw new Error('HTTP 404');
    const body = bodies[url] ?? 'x'.repeat(8);
    if (opaque.includes(url)) return { type: 'opaque', ok: true, status: 200, body: null, headers: new Headers() };
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
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('0123456789'));
    const one = await s.status();
    assert.deepEqual([one.count, one.bytes, one.tier1Present, one.complete], [1, 10, 1, false]);
  });

  test('downloads the essential tier first, then the rest, skipping what is cached', async () => {
    const m = manifest([
      { url: '/assets/ui/a.png', tier: 1, size: 8 },
      { url: '/assets/avatar/b.png', tier: 1, size: 8 },
      { url: '/assets/spine/c.skel', tier: 2, size: 8 },
      { url: '/assets/spine/d.png', tier: 2, size: 8 },
    ]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/avatar/b.png`, new Response('cached!!'));
    const { fetch, calls } = fetcherFor();
    const s = store(m, { caches, fetch });
    const seen = [];
    const res = await s.download({ onProgress: (p) => seen.push(p) });
    assert.deepEqual(calls, [`${ORIGIN}/assets/ui/a.png`, `${ORIGIN}/assets/spine/c.skel`, `${ORIGIN}/assets/spine/d.png`], 'cached file skipped, essential first');
    assert.equal(res.complete, true);
    assert.deepEqual([res.done, res.total, res.bytes, res.totalBytes, res.failed], [4, 4, 32, 32, 0]);
    assert.equal(seen.at(-1).complete, true);
    assert.equal(seen.at(-1).done, 4);
    const cached = await (await caches.open(cacheName('v1'))).match(`${ORIGIN}/assets/spine/c.skel`);
    assert.equal(await cached.text(), 'x'.repeat(8));
    assert.equal(cached.headers.get('x-sp-resource'), '1', 'entries are marked as ours');
    assert.equal(cached.headers.get('accept-ranges'), 'bytes');
    assert.equal(cached.headers.get('content-length'), null, 'no stale length of the compressed transfer');
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
    assert.equal(res.done, 1);
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
    const cache = await caches.open(cacheName('v1'));
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
    assert.equal(res.done, 30);
    assert.equal(seen[0].done, 0);
    assert.deepEqual(seen.at(-1), res, 'the last update is the result');
    assert.ok(seen.every((p, i) => i === 0 || p.done >= seen[i - 1].done), 'monotonic');
  });

  test('clear deletes every version, pruneOld only the stale ones', async () => {
    const m = manifest([{ url: '/assets/a.png', tier: 1, size: 8 }]);
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('old'));
    await (await caches.open(cacheName('v0'))).put(`${ORIGIN}/assets/removed.png`, new Response('ancient'));
    await caches.open('unrelated-cache');
    const s = store(m, { caches, fetch: fetcherFor().fetch });
    assert.deepEqual(await s.pruneOld(), [`${CACHE_PREFIX}v0`]);
    assert.deepEqual(await caches.keys(), [cacheName('v1'), 'unrelated-cache']);
    const after = await s.clear();
    assert.deepEqual(await caches.keys(), ['unrelated-cache'], 'other caches of the origin are never touched');
    assert.equal(after.count, 0);
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
    await a;
    assert.equal(calls.length, 1);
  });
});

describe('the Service Worker handler', () => {
  const cached = async () => {
    const caches = new MemoryCaches();
    await (await caches.open(cacheName('v1'))).put(`${ORIGIN}/assets/a.png`, new Response('0123456789', { headers: { 'Content-Type': 'image/png' } }));
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
    await (await caches.open(cacheName('v1'))).put(url, new Response('skel-bytes'));
    const res = await handleResourceRequest(new Request(url), { caches });
    assert.equal(await res.text(), 'skel-bytes');
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
    await rangeResponse(await (await caches.open(cacheName('v1'))).match(`${ORIGIN}/assets/a.png`), 'bytes=0-1');
    const again = await handleResourceRequest(new Request(`${ORIGIN}/assets/a.png`), { caches });
    assert.equal(await again.text(), '0123456789');
  });
});
