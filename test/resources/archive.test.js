import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '../../public/vendor/zip.module.js';
import { ARCHIVE_MANIFEST, MAX_ARCHIVE_BYTES, exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { CACHE_NAME, indexUrl } from '../../public/js/resources/common.js';
import { handleResourceRequest } from '../../public/js/resources/service.js';

class MemoryCache {
  entries = new Map();
  async put(key, response) { this.entries.set(typeof key === 'string' ? key : key.url, response.clone()); }
  async match(key) { return this.entries.get(typeof key === 'string' ? key : key.url)?.clone(); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(key) { return this.entries.delete(typeof key === 'string' ? key : key.url); }
}
class MemoryCaches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new MemoryCache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}
const hash = (data, algorithm = 'sha1') => createHash(algorithm).update(data).digest('hex');
const file = (url, body, tier = 1) => ({ url, size: Buffer.byteLength(body), hash: hash(body).slice(0, 12), tier, body });
function store(files, { caches = new MemoryCaches(), origin = 'https://game.example', version = 'v1' } = {}) {
  const calls = [];
  const instance = new ResourceStore({ format: 1, version, files, sized: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0) }, { caches, origin, fetcher: async (url) => {
    calls.push(url);
    const f = files.find((f) => instance.keyOf(f.url) === url);
    return new Response(f.body, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(f.size) } });
  } });
  return { store: instance, calls, caches };
}

async function packageZip(files, { level = 0, mutate, extra } = {}) {
  const rows = files.map((f, i) => ({ path: `resources/${i}`, url: f.url, hash: hash(f.body).slice(0, 12),
    sha256: hash(f.body, 'sha256'), size: Buffer.byteLength(f.body) }));
  mutate?.(rows);
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level });
  for (let i = 0; i < files.length; i++) await zip.add(`resources/${i}`, new BlobReader(new Blob([files[i].body])));
  if (extra) await zip.add(extra, new BlobReader(new Blob(['unexpected'])));
  await zip.add(ARCHIVE_MANIFEST, new BlobReader(new Blob([JSON.stringify({ format: 'stronghold-resource-zip', version: 1, files: rows })])));
  return zip.close();
}

test('export/import round trip includes only cached files and serves imported bytes with correct MIME and ranges', async () => {
  const files = [file('/assets/char/a.png', 'character'), file('/assets/audio/bgm/a.mp3', 'music', 2)];
  const source = store(files);
  await source.store.download({ tiers: [1] });
  const exported = await exportResourceZip(source.store);
  assert.equal(exported.count, 1);
  const zip = new ZipReader(new BlobReader(exported.blob), { useWebWorkers: false });
  assert.deepEqual((await zip.getEntries()).map((e) => e.filename), ['resources/0', ARCHIVE_MANIFEST]);
  await zip.close();
  const target = store(files, { origin: 'https://other.example' });
  const result = await importResourceZip(target.store, exported.blob);
  assert.equal(result.imported, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(target.calls, [], 'ZIP import performs no resource network requests');
  const response = await handleResourceRequest(new Request('https://other.example/assets/char/a.png', { headers: { Range: 'bytes=1-3' } }), { caches: target.caches });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), 'har');
  const second = await importResourceZip(target.store, exported.blob);
  assert.equal(second.imported, 0, 'current files are not overwritten');
  await (await target.caches.open(CACHE_NAME)).put('https://other.example/assets/char/a.png', new Response('damaged'));
  assert.equal((await importResourceZip(target.store, exported.blob)).imported, 1, 'a damaged cached copy is replaced by verified package bytes');
});

test('old ZIP reuses unchanged files across CDN prefixes, skips stale/removed/unverifiable files, downloads only the remainder', async () => {
  const old = [file('/assets/map/a.png', 'same'), file('/assets/char/b.png', 'old'), file('/assets/gone.png', 'gone'), file('/fonts/x.woff2', 'font')];
  const source = store(old);
  await source.store.download();
  const exported = await exportResourceZip(source.store);
  const next = [file('https://cdn.example/new/assets/map/a.png', 'same'), file('https://cdn.example/new/assets/char/b.png', 'new'),
    file('https://cdn.example/new/assets/spine/c.skel', 'added'), { ...file('/fonts/x.woff2', 'font'), hash: 'syn-new' }];
  const target = store(next, { version: 'v2' });
  const result = await importResourceZip(target.store, exported.blob);
  assert.deepEqual([result.imported, result.compatible, result.skippedPackage], [1, 1, 3]);
  assert.equal((await target.store.status()).count, 1);
  await target.store.download();
  assert.deepEqual(target.calls, next.slice(1).map((f) => target.store.keyOf(f.url)));
  assert.equal((await target.store.status()).complete, true);
});

test('packages exported with synthetic server hashes become fully reusable after the server hash table is completed', async () => {
  const files = [file('/assets/char/a.png', 'portrait'), file('/assets/spine/b.skel', 'spine'), file('/assets/map/c.png', 'map')];
  const source = store(files.map((f) => ({ ...f, hash: 'syn-old-manifest' })));
  await source.store.download();
  const exported = await exportResourceZip(source.store);
  assert.equal(exported.count, 3, 'export records the actual bytes even when server hashes were synthetic');
  const incomplete = store(files.map((f) => ({ ...f, hash: 'syn-old-manifest' })));
  const skipped = await importResourceZip(incomplete.store, exported.blob);
  assert.deepEqual([skipped.imported, skipped.skippedPackage], [0, 3]);
  const completed = store(files, { version: 'completed-hashes' });
  const result = await importResourceZip(completed.store, exported.blob);
  assert.deepEqual([result.imported, result.skippedPackage], [3, 0]);
  assert.equal(result.complete, true);
  await completed.store.download();
  assert.deepEqual(completed.calls, [], 'the original ZIP suffices; no second export or resource download is needed');
});

test('a corrupted entry or wrong digest rejects the whole package before any live file changes', async () => {
  const files = [file('/assets/a.png', 'aaa'), file('/assets/b.png', 'bbb')];
  const target = store(files);
  await target.store.download();
  const cache = await target.caches.open(CACHE_NAME);
  const before = await (await cache.match(indexUrl(target.store.origin))).text();
  const wrong = await packageZip(files, { mutate: (rows) => { rows[1].sha256 = '0'.repeat(64); } });
  await assert.rejects(importResourceZip(target.store, wrong), /校验失败/);
  assert.equal(await (await cache.match(indexUrl(target.store.origin))).text(), before);
  const valid = await packageZip(files);
  const bytes = new Uint8Array(await valid.arrayBuffer());
  const view = new DataView(bytes.buffer);
  bytes[30 + view.getUint16(26, true) + view.getUint16(28, true)] ^= 1;
  await assert.rejects(importResourceZip(target.store, new Blob([bytes])));
  assert.equal(await (await cache.match(target.store.keyOf(files[0].url))).text(), 'aaa');
  const empty = store(files);
  await assert.rejects(importResourceZip(empty.store, wrong), /校验失败/);
  assert.equal((await empty.store.status()).count, 0, 'even earlier valid entries are not installed');
});

test('compressed ZIP is supported and truncated ZIP is refused', async () => {
  const files = [file('/assets/spine/a.atlas', 'atlas'.repeat(1000))];
  const blob = await packageZip(files, { level: 6 });
  assert.ok(blob.size < files[0].size);
  const target = store(files);
  assert.equal((await importResourceZip(target.store, blob)).imported, 1);
  await assert.rejects(importResourceZip(store(files).store, blob.slice(0, blob.size - 40)));
});

test('invalid paths, mismatched listings, missing manifest and oversized packages are refused', async () => {
  const files = [file('/assets/a.png', 'a')];
  for (const options of [
    { extra: '../assets/code.js' },
    { extra: 'resources/1' },
    { mutate: (rows) => { rows[0].url = '/build/assets/a.png'; } },
    { mutate: (rows) => { rows[0].url = '/assets/%2e%2e/a.png'; } },
    { mutate: (rows) => { rows[0].size = 24 * 1024 * 1024 + 1; } },
    { mutate: (rows) => { rows.push({ ...rows[0] }); } },
  ]) await assert.rejects(importResourceZip(store(files).store, await packageZip(files, options)));
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0 });
  await zip.add('resources/0', new BlobReader(new Blob(['a'])));
  await assert.rejects(importResourceZip(store(files).store, await zip.close()), /缺少/);
  await assert.rejects(importResourceZip(store(files).store, { size: MAX_ARCHIVE_BYTES + 1, slice() {} }), /2 GiB/);
});

test('cancellation keeps only already imported verified entries; quota errors flush completed progress', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b')];
  const blob = await packageZip(files);
  const target = store(files);
  const controller = new AbortController();
  await assert.rejects(importResourceZip(target.store, blob, { signal: controller.signal, onProgress: (p) => {
    if (p.phase === 'import' && p.done === 1) controller.abort();
  } }), (err) => err.name === 'AbortError');
  assert.equal((await target.store.status()).count, 1);
  const second = store(files);
  const cache = await second.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  cache.put = async (url, res) => {
    if (url.endsWith('/assets/b.png')) throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
    return put(url, res);
  };
  await assert.rejects(importResourceZip(second.store, blob), (err) => err.name === 'QuotaExceededError');
  assert.equal((await second.store.status()).count, 1);
});

test('export rejects corrupted cached bytes instead of endorsing them in a package', async () => {
  const target = store([file('/assets/a.png', 'correct')]);
  await target.store.download();
  await (await target.caches.open(CACHE_NAME)).put(target.store.keyOf('/assets/a.png'), new Response('incorrect'));
  await assert.rejects(exportResourceZip(target.store), /缓存资源校验失败/);
});
