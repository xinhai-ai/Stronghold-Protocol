import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '../../public/vendor/zip.module.js';
import { Crc32 } from '../../public/vendor/zip-crc32.module.js';
import { ARCHIVE_MANIFEST, MAX_ARCHIVE_BYTES, exportResourceZip, importResourceZip } from '../../public/js/resources/archive.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { verifyResourceBytes } from '../../public/js/resources/integrity.js';
import { CACHE_NAME, indexUrl } from '../../public/js/resources/common.js';
import { handleResourceRequest } from '../../public/js/resources/service.js';
import { VENDOR_FILES } from '../../tools/vendor.mjs';
import { ZIP_READ_BLOCK_BYTES } from '../../public/js/resources/zipReader.js';

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

test('vendor preparation supplies the upstream zip.js CRC codec used for stored-entry verification', () => {
  assert.ok(VENDOR_FILES.some(([source, target]) => source === 'node_modules/@zip.js/zip.js/lib/core/streams/codecs/crc32.js'
    && target === 'zip-crc32.module.js'));
  const crc = new Crc32();
  crc.append(new TextEncoder().encode('123456789'));
  assert.equal(crc.get() >>> 0, 0xcbf43926, 'the standard CRC-32 reference vector');
});
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

async function packageZip(files, { level = 0, mutate, extra, version = 1 } = {}) {
  const rows = files.map((f, i) => ({ path: `resources/${i}`, url: f.url, hash: hash(f.body).slice(0, 12),
    ...(version === 2 ? { sha1: hash(f.body) } : { sha256: hash(f.body, 'sha256') }), size: Buffer.byteLength(f.body) }));
  mutate?.(rows);
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level });
  for (let i = 0; i < files.length; i++) await zip.add(`resources/${i}`, new BlobReader(new Blob([files[i].body])));
  if (extra) await zip.add(extra, new BlobReader(new Blob(['unexpected'])));
  await zip.add(ARCHIVE_MANIFEST, new BlobReader(new Blob([JSON.stringify({ format: 'stronghold-resource-zip', version, files: rows })])));
  return zip.close();
}

test('export/import round trip includes only cached files and serves imported bytes with correct MIME and ranges', async () => {
  const files = [file('/assets/char/a.png', 'character'), file('/assets/audio/bgm/a.mp3', 'music', 2)];
  const source = store(files);
  await source.store.download({ tiers: [1] });
  const exported = await exportResourceZip(source.store);
  assert.equal(exported.count, 1);
  const zip = new ZipReader(new BlobReader(exported.blob), { useWebWorkers: false });
  const entries = await zip.getEntries();
  assert.deepEqual(entries.map((e) => e.filename), ['resources/0', ARCHIVE_MANIFEST]);
  const doc = JSON.parse(await (await entries[1].getData(new BlobWriter())).text());
  assert.equal(doc.version, 2);
  assert.equal(doc.files[0].sha1, hash(files[0].body));
  assert.equal(doc.files[0].hash, doc.files[0].sha1.slice(0, 12));
  assert.equal(doc.files[0].sha256, undefined);
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

test('a corrupted entry or wrong digest stops import, preserving existing and earlier verified files', async () => {
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
  await assert.rejects(importResourceZip(empty.store, wrong, { concurrency: 1 }), /校验失败/);
  assert.equal((await empty.store.status()).count, 1, 'earlier verified entries are installed and indexed');
  const partial = await empty.caches.open(CACHE_NAME);
  assert.equal(await (await partial.match(empty.store.keyOf(files[0].url))).text(), 'aaa');
  assert.equal(await partial.match(empty.store.keyOf(files[1].url)), undefined, 'the failed entry is never written');
  assert.equal((await importResourceZip(empty.store, valid)).imported, 1, 'retry reuses the completed valid entry');
});

test('stored resources check their headers once per file, with no all-file scan before writing', async (t) => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b'), file('/assets/removed.png', 'old')];
  const blob = await packageZip(files);
  const target = store(files.slice(0, 2));
  await target.store.download({ tiers: [1] });
  const reads = [];
  const headers = [];
  const events = [];
  const generator = ZipReader.prototype.getEntriesGenerator;
  t.mock.method(ZipReader.prototype, 'getEntriesGenerator', async function* (...args) {
    for await (const entry of generator.apply(this, args)) {
      const getData = entry.getData;
      entry.getData = (writer, options) => {
        if (options?.checkOverlappingEntryOnly) headers.push(entry.filename);
        if (entry.filename.startsWith('resources/')) {
          reads.push(entry.filename);
          events.push(`read:${entry.filename}`);
        }
        return getData(writer, options);
      };
      yield entry;
    }
  });
  const cache = await target.caches.open(CACHE_NAME);
  await cache.delete(target.store.keyOf(files[1].url));
  const put = cache.put.bind(cache);
  cache.put = async (key, response) => {
    if (key.endsWith(files[1].url)) events.push('write:resources/1');
    await put(key, response);
  };
  const result = await importResourceZip(target.store, blob, { concurrency: 1 });
  assert.deepEqual([result.imported, result.compatible, result.skippedPackage], [1, 2, 1]);
  assert.deepEqual(reads, ['resources/0', 'resources/1', 'resources/2']);
  assert.deepEqual(headers, [ARCHIVE_MANIFEST, 'resources/0', 'resources/1', 'resources/2'],
    'header-only validation accompanies each direct body read; no extra pass is performed');
  assert.deepEqual(events, ['read:resources/0', 'read:resources/1', 'write:resources/1', 'read:resources/2'],
    'a verified resource is written before the next package resource is read');
});

test('stored ZIP payloads avoid Blob.stream and are CRC-checked once using the library codec', async (t) => {
  const files = [file('/assets/a.png', 'a'.repeat(32 * 1024)), file('/assets/b.png', 'b')];
  const blob = await packageZip(files, { version: 2 });
  const stream = Blob.prototype.stream;
  const append = Crc32.prototype.append;
  let streams = 0;
  const crcInputs = [];
  t.mock.method(Blob.prototype, 'stream', function (...args) { streams++; return stream.apply(this, args); });
  t.mock.method(Crc32.prototype, 'append', function (bytes) { crcInputs.push(bytes.byteLength); return append.call(this, bytes); });
  let diagnostics;
  const target = store(files);
  assert.equal((await importResourceZip(target.store, blob, { onDiagnostics: (p) => { diagnostics = p; } })).imported, 2);
  assert.equal(streams, 0, 'stored bodies use direct reads instead of the stream-copy/CRC pipeline');
  assert.equal(crcInputs.filter((size) => size === files[0].size).length, 1);
  assert.equal(crcInputs.filter((size) => size === files[1].size).length, 1);
  assert.equal(diagnostics.storedFiles, 2);
  assert.ok(diagnostics.metadataMs >= 0 && diagnostics.bodyReadMs >= 0 && diagnostics.crcMs >= 0);
});

test('stored fast path refuses a false ZIP CRC even when both package digests still match the unchanged payload', async () => {
  const files = [file('/assets/a.png', 'payload')];
  const blob = await packageZip(files);
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const directoryOffset = reader.directoryOffset;
  await reader.close();
  const entry = entries.find((e) => e.filename === 'resources/0');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const headerOffset = Buffer.from(bytes).indexOf('resources/0', directoryOffset) - 46;
  assert.equal(view.getUint32(headerOffset, true), 0x02014b50);
  const wrongCrc = (entry.crc32 ^ 0xffffffff) >>> 0;
  view.setUint32(headerOffset + 16, wrongCrc, true);
  const dataOffset = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const descriptorOffset = dataOffset + entry.compressedSize;
  assert.equal(view.getUint32(descriptorOffset, true), 0x08074b50);
  view.setUint32(descriptorOffset + 4, wrongCrc, true);
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, new Blob([bytes])), /CRC 校验失败/);
  assert.equal((await target.store.status()).count, 0);
});

test('stored fast path checks actual body length instead of trusting a clamped or shortened file slice', async () => {
  const files = [file('/assets/a.png', 'a'.repeat(ZIP_READ_BLOCK_BYTES + 1))];
  const blob = await packageZip(files, { version: 2 });
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  await reader.close();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entry = entries[0];
  const dataOffset = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const shortened = { size: blob.size, arrayBuffer: () => blob.arrayBuffer(), slice(start, end) {
    const part = blob.slice(start, end);
    return start === dataOffset && end === dataOffset + files[0].size ? part.slice(0, part.size - 1) : part;
  } };
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, shortened), /ZIP 文件不完整/);
  assert.equal((await target.store.status()).count, 0);
});

test('ZIP metadata and small stored bodies share bounded file blocks across entries', async (t) => {
  const files = Array.from({ length: 300 }, (_, i) => file(`/assets/${i}.png`, String(i % 10).repeat(4096)));
  const blob = await packageZip(files, { version: 2 });
  const target = store(files);
  const read = BlobReader.prototype.readUint8Array;
  const reads = [];
  t.mock.method(BlobReader.prototype, 'readUint8Array', function (offset, length) {
    reads.push([offset, length]);
    return read.call(this, offset, length);
  });
  assert.equal((await importResourceZip(target.store, blob)).imported, files.length);
  assert.ok(reads.length < 12, 'hundreds of payloads and metadata share a handful of reads');
  assert.ok(reads.every(([, length]) => length <= ZIP_READ_BLOCK_BYTES));
  const cache = await target.caches.open(CACHE_NAME);
  for (const file of files) assert.equal(await (await cache.match(target.store.keyOf(file.url))).text(), file.body);
});

test('late CRC failures preserve earlier files; skipped and already cached files still require both package digests', async () => {
  const files = [file('/assets/a.png', 'aaa'), file('/assets/b.png', 'bbb')];
  const valid = await packageZip(files);
  const zip = new ZipReader(new BlobReader(valid), { useWebWorkers: false });
  const entries = await zip.getEntries();
  const offset = entries.find((e) => e.filename === 'resources/1').offset;
  await zip.close();
  const bytes = new Uint8Array(await valid.arrayBuffer());
  const view = new DataView(bytes.buffer);
  bytes[offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)] ^= 1;
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, new Blob([bytes]), { concurrency: 1 }));
  assert.equal((await target.store.status()).count, 1);
  for (const field of ['hash', 'sha256']) {
    const wrong = await packageZip(files, { mutate: (rows) => { rows[1][field] = '0'.repeat(field === 'hash' ? 12 : 64); } });
    const skipped = store(files.slice(0, 1));
    await assert.rejects(importResourceZip(skipped.store, wrong, { concurrency: 1 }), /校验失败/);
    assert.equal((await skipped.store.status()).count, 1, 'earlier file survives a bad skipped entry');
    const cached = store(files);
    await cached.store.download();
    await assert.rejects(importResourceZip(cached.store, wrong), /校验失败/);
    assert.equal((await cached.store.status()).count, 2, 'a bad package cannot replace valid existing copies');
  }
});

test('a malformed later local ZIP header stops import and preserves the earlier valid resource', async () => {
  const files = [file('/assets/a.png', 'aaa'), file('/assets/b.png', 'bbb')];
  const blob = await packageZip(files);
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  await reader.close();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[entries.find((e) => e.filename === 'resources/1').offset] = 0;
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, new Blob([bytes]), { concurrency: 1 }));
  assert.equal((await target.store.status()).count, 1);
});

test('ZIP entry overlap is rejected before that entry is written, even when both claimed resources have identical bytes', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'a')];
  const blob = await packageZip(files);
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const directoryOffset = reader.directoryOffset;
  await reader.close();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const nameOffset = Buffer.from(bytes).indexOf('resources/1', directoryOffset);
  assert.ok(nameOffset >= directoryOffset);
  const headerOffset = nameOffset - 46;
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(headerOffset, true), 0x02014b50);
  view.setUint32(headerOffset + 42, entries.find((e) => e.filename === 'resources/0').offset, true);
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, new Blob([bytes]), { concurrency: 1 }), /Overlapping/);
  assert.equal((await target.store.status()).count, 1);
  const cache = await target.caches.open(CACHE_NAME);
  assert.equal(await cache.match(target.store.keyOf(files[1].url)), undefined);
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
  ]) {
    const target = store(files);
    await assert.rejects(importResourceZip(target.store, await packageZip(files, options)));
    assert.equal((await target.store.status()).count, 0, 'invalid structure or manifest cannot install any entries');
  }
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
  await assert.rejects(importResourceZip(target.store, blob, { concurrency: 1, signal: controller.signal, onProgress: (p) => {
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
  await assert.rejects(importResourceZip(second.store, blob, { concurrency: 1 }), (err) => err.name === 'QuotaExceededError');
  assert.equal((await second.store.status()).count, 1);
});

test('export rejects corrupted cached bytes instead of endorsing them in a package', async () => {
  const target = store([file('/assets/a.png', 'correct')]);
  await target.store.download();
  await (await target.caches.open(CACHE_NAME)).put(target.store.keyOf('/assets/a.png'), new Response('incorrect'));
  await assert.rejects(exportResourceZip(target.store), /缓存资源校验失败/);
});

test('an index flush failure does not hide the resource corruption that stopped import', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b')];
  const wrong = await packageZip(files, { mutate: (rows) => { rows[1].sha256 = '0'.repeat(64); } });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  cache.put = (key, response) => {
    if (key === indexUrl(target.store.origin)) throw new DOMException('', 'QuotaExceededError');
    return put(key, response);
  };
  await assert.rejects(importResourceZip(target.store, wrong, { concurrency: 1 }), /校验失败/);
  assert.equal(await (await cache.match(target.store.keyOf(files[0].url))).text(), 'a');
  assert.equal(await cache.match(target.store.keyOf(files[1].url)), undefined);
});

test('the store independently checks imported byte fingerprints and actual sizes', async () => {
  const files = [file('/assets/a.png', 'a')];
  const target = store(files);
  await assert.rejects(target.store.importFiles(target.store.files, { read: async () => new Uint8Array([98]) }), /资源校验失败/);
  await assert.rejects(target.store.importFiles(target.store.files, { read: async () => new Uint8Array(2) }), /资源大小无效/);
  assert.equal((await target.store.status()).count, 0);
});

test('legacy ZIP import hashes each package payload once per algorithm, reusing verified bytes for every destination', async (t) => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'bb'), file('/assets/removed.png', 'old')];
  const blob = await packageZip(files);
  const target = store([files[0], { ...files[0], url: 'https://cdn.example/prefix/assets/a.png' }, files[1]]);
  const calls = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, bytes) => {
    calls.push([algorithm, bytes.byteLength]);
    return digest(algorithm, bytes);
  });
  assert.equal((await importResourceZip(target.store, blob)).imported, 3);
  assert.deepEqual(calls.toSorted(), [['SHA-256', 1], ['SHA-1', 1], ['SHA-256', 2], ['SHA-1', 2], ['SHA-256', 3], ['SHA-1', 3]].toSorted(),
    'writing an additional URL for the same verified payload does not hash it again; skipped entries remain verified');
});

test('SHA-1 ZIP import hashes each payload once, including skipped files and multiple CDN destinations', async (t) => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'bb'), file('/assets/removed.png', 'old')];
  const blob = await packageZip(files, { version: 2 });
  const target = store([files[0], { ...files[0], url: 'https://cdn.example/prefix/assets/a.png' }, files[1]]);
  const calls = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, bytes) => {
    calls.push([algorithm, bytes.byteLength]);
    return digest(algorithm, bytes);
  });
  const result = await importResourceZip(target.store, blob);
  assert.deepEqual([result.imported, result.skippedPackage], [3, 1]);
  assert.deepEqual(calls.toSorted(), [['SHA-1', 1], ['SHA-1', 2], ['SHA-1', 3]].toSorted(), 'no SHA-256 or repeated store digest');
});

test('SHA-1 ZIP checks the full digest beyond the server prefix and preserves earlier completed files', async () => {
  const files = [file('/assets/a.png', 'aaa'), file('/assets/b.png', 'bbb')];
  const wrong = await packageZip(files, { version: 2, mutate: (rows) => {
    rows[1].sha1 = rows[1].sha1.slice(0, 12) + '0'.repeat(28);
  } });
  const target = store(files);
  await assert.rejects(importResourceZip(target.store, wrong, { concurrency: 1 }), /校验失败/);
  assert.equal((await target.store.status()).count, 1, 'only the earlier verified file is indexed');
  const cache = await target.caches.open(CACHE_NAME);
  assert.equal(await cache.match(target.store.keyOf(files[1].url)), undefined);
  const valid = await packageZip(files, { version: 2 });
  assert.equal((await importResourceZip(target.store, valid)).imported, 1);
});

test('ZIP version selects a mandatory digest schema, with no downgrade from a missing legacy SHA-256', async () => {
  const files = [file('/assets/a.png', 'aaa'), file('/assets/b.png', 'bbb')];
  for (const options of [
    { version: 3 },
    { version: '2' },
    { version: 1, mutate: (rows) => { delete rows[1].sha256; rows[1].sha1 = hash(files[1].body); } },
    { version: 2, mutate: (rows) => { delete rows[1].sha1; rows[1].sha256 = hash(files[1].body, 'sha256'); } },
    { version: 2, mutate: (rows) => { rows[1].sha1 = rows[1].hash; } },
    { version: 2, mutate: (rows) => { rows[1].sha1 = '0'.repeat(40); } },
  ]) {
    const target = store(files);
    await assert.rejects(importResourceZip(target.store, await packageZip(files, options)));
    assert.equal((await target.store.status()).count, 0, 'invalid version or digest metadata is rejected before any writes');
  }
});

test('compressed SHA-1 ZIP remains single-hash and still rejects bad CRCs, cancellation and quota errors', async (t) => {
  const files = [file('/assets/spine/a.atlas', 'atlas'.repeat(1000)), file('/assets/b.png', 'b')];
  const blob = await packageZip(files, { version: 2, level: 6 });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const calls = [];
  t.mock.method(crypto.subtle, 'digest', (algorithm, bytes) => {
    calls.push([algorithm, bytes.byteLength]);
    return digest(algorithm, bytes);
  });
  assert.equal((await importResourceZip(store(files).store, blob)).imported, 2);
  assert.deepEqual(calls.toSorted(), [['SHA-1', files[0].size], ['SHA-1', files[1].size]].toSorted());
  const cancelled = store(files);
  const controller = new AbortController();
  await assert.rejects(importResourceZip(cancelled.store, blob, { concurrency: 1, signal: controller.signal, onProgress: (p) => {
    if (p.phase === 'import' && p.done === 1) controller.abort();
  } }), (err) => err.name === 'AbortError');
  assert.equal((await cancelled.store.status()).count, 1);
  const quota = store(files);
  const cache = await quota.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  cache.put = (key, response) => {
    if (key.endsWith(files[1].url)) throw new DOMException('', 'QuotaExceededError');
    return put(key, response);
  };
  await assert.rejects(importResourceZip(quota.store, blob, { concurrency: 1 }), (err) => err.name === 'QuotaExceededError');
  assert.equal((await quota.store.status()).count, 1);
  const stored = await packageZip(files, { version: 2 });
  const reader = new ZipReader(new BlobReader(stored), { useWebWorkers: false });
  const entries = await reader.getEntries();
  await reader.close();
  const offset = entries.find((e) => e.filename === 'resources/1').offset;
  const bytes = new Uint8Array(await stored.arrayBuffer());
  const view = new DataView(bytes.buffer);
  bytes[offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)] ^= 1;
  const corrupt = store(files);
  await assert.rejects(importResourceZip(corrupt.store, new Blob([bytes]), { concurrency: 1 }));
  assert.equal((await corrupt.store.status()).count, 1);
});

test('checking an existing cache copy hashes those distinct bytes once and reuses the package result for repair', async (t) => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'bb')];
  const blob = await packageZip(files);
  const target = store(files);
  await target.store.download();
  const cache = await target.caches.open(CACHE_NAME);
  await cache.put(target.store.keyOf(files[1].url), new Response('damaged'));
  const calls = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, bytes) => {
    calls.push([algorithm, bytes.byteLength]);
    return digest(algorithm, bytes);
  });
  assert.equal((await importResourceZip(target.store, blob)).imported, 1);
  assert.deepEqual(calls.toSorted(), [['SHA-256', 1], ['SHA-1', 1], ['SHA-1', 1],
    ['SHA-256', 2], ['SHA-1', 2], ['SHA-1', 7]].toSorted(), 'the repaired package bytes are not hashed a third time');
  assert.equal(await (await cache.match(target.store.keyOf(files[1].url))).text(), 'bb');
});

test('the store rejects fabricated verification records and proofs for another current fingerprint or size', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b')];
  const target = store(files);
  const bytes = new Uint8Array([97]);
  const expected = { hash: files[0].hash, sha256: hash('a', 'sha256') };
  await assert.rejects(target.store.importFiles([target.store.files[0]], { read: async () => ({ bytes, ...expected }) }), /资源大小无效/);
  const proof = await verifyResourceBytes(bytes, expected);
  await assert.rejects(target.store.importFiles([target.store.files[1]], { read: async () => proof }), /资源大小无效/);
  const wrongSize = store([{ ...files[0], size: 2 }]);
  await assert.rejects(wrongSize.store.importFiles(wrongSize.store.files, { read: async () => proof }), /资源大小无效/);
  assert.equal((await target.store.status()).count, 0);
  assert.equal((await wrongSize.store.status()).count, 0);
  await assert.rejects(verifyResourceBytes(bytes, { ...expected, sha256: '0'.repeat(64) }), /资源包校验失败/);
});

test('ZIP export hashes each resource only once with SHA-1, without resource array slicing', async (t) => {
  const files = [file('/assets/a.png', 'a'.repeat(1024 * 1024))];
  const target = store(files);
  await target.store.download();
  const calls = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', (algorithm, bytes) => {
    calls.push([algorithm, bytes.byteLength]);
    return digest(algorithm, bytes);
  });
  const slice = Uint8Array.prototype.slice;
  let sliced = 0;
  t.mock.method(Uint8Array.prototype, 'slice', function (...args) {
    const result = slice.apply(this, args);
    sliced += result.byteLength;
    return result;
  });
  assert.equal((await exportResourceZip(target.store)).count, 1);
  assert.deepEqual(calls, [['SHA-1', files[0].size]]);
  assert.ok(sliced < files[0].size, 'the ZIP writer does not slice a full resource through Uint8ArrayReader');
});

test('small imports overlap cache writes within four slots; large resources are exclusive and counters remain immutable', async () => {
  const files = [
    ...Array.from({ length: 6 }, (_, i) => file(`/assets/char/${i}.png`, 's'.repeat(64 * 1024))),
    file('/assets/spine/big.skel', 'l'.repeat(2 * 1024 * 1024)),
    file('/assets/audio/bgm/end.mp3', 'music', 2),
  ];
  const blob = await packageZip(files, { version: 2 });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  let active = 0;
  let maxActive = 0;
  let activeBig = false;
  const snapshots = [];
  cache.put = async (key, response) => {
    if (key === indexUrl(target.store.origin)) return put(key, response);
    const big = key.endsWith('/big.skel');
    if (big) assert.equal(active, 0, 'the large resource waits for all small writes');
    else assert.equal(activeBig, false, 'small writes cannot overlap the large resource');
    active++;
    activeBig = big;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await put(key, response);
    active--;
    if (big) activeBig = false;
  };
  const result = await importResourceZip(target.store, blob, { onProgress: (p) => {
    if (p.getStatus) snapshots.push(p.getStatus());
  } });
  assert.ok(maxActive > 1 && maxActive <= 4, 'cache latency overlaps but remains bounded');
  assert.equal(result.timings.maxInFlight, 4);
  assert.equal(result.timings.maxInFlightBytes, files[6].size, 'the largest slot is the exclusive large resource');
  assert.equal(result.imported, files.length);
  assert.equal(snapshots[0].count, 0);
  assert.ok(snapshots[0].groups.every((g) => g.present === 0), 'later updates cannot mutate earlier UI snapshots');
  const last = snapshots.at(-1);
  const actual = await target.store.status();
  assert.deepEqual(last.groups, actual.groups);
  assert.deepEqual([last.count, last.bytes, last.sized, last.tier1Present, last.tier2Present],
    [actual.count, actual.bytes, actual.sized, actual.tier1Present, actual.tier2Present]);
});

test('a failed parallel import waits for an already-started valid write and indexes it before rejecting', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b')];
  const blob = await packageZip(files, { version: 2 });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const quotaRaised = Promise.withResolvers();
  cache.put = async (key, response) => {
    if (key.endsWith('/a.png')) { started.resolve(); await release.promise; }
    if (key.endsWith('/b.png')) {
      await started.promise;
      quotaRaised.resolve();
      throw new DOMException('', 'QuotaExceededError');
    }
    await put(key, response);
  };
  let settled = false;
  let diagnostics;
  const importing = importResourceZip(target.store, blob, { onDiagnostics: (p) => { diagnostics = p; } });
  importing.then(() => { settled = true; }, () => { settled = true; });
  await quotaRaised.promise;
  await new Promise(setImmediate);
  assert.equal(settled, false, 'the archive and download lock remain held while a put is unfinished');
  assert.equal(await cache.match(indexUrl(target.store.origin)), undefined);
  release.resolve();
  await assert.rejects(importing, (err) => err.name === 'QuotaExceededError');
  assert.equal((await target.store.status()).count, 1);
  assert.equal(await (await cache.match(target.store.keyOf(files[0].url))).text(), 'a');
  assert.equal(await cache.match(target.store.keyOf(files[1].url)), undefined);
  assert.equal(diagnostics.failed, true);
  assert.equal(diagnostics.imported, 1);
});

test('parallel cancellation starts no further writes and retains all four writes already in flight', async () => {
  const files = Array.from({ length: 7 }, (_, i) => file(`/assets/${i}.png`, String(i)));
  const blob = await packageZip(files, { version: 2 });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  const allStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const controller = new AbortController();
  let started = 0;
  cache.put = async (key, response) => {
    if (key !== indexUrl(target.store.origin)) {
      assert.equal(controller.signal.aborted, false, 'no resource put starts after cancellation');
      if (++started === 4) allStarted.resolve();
      await release.promise;
    }
    await put(key, response);
  };
  let settled = false;
  const importing = importResourceZip(target.store, blob, { signal: controller.signal });
  importing.then(() => { settled = true; }, () => { settled = true; });
  await allStarted.promise;
  controller.abort();
  await new Promise(setImmediate);
  assert.equal(settled, false);
  release.resolve();
  await assert.rejects(importing, (err) => err.name === 'AbortError');
  assert.equal(started, 4);
  assert.equal((await target.store.status()).count, 4);
});

test('parallel index checkpoints never overlap and the final index contains every successful write', async () => {
  const files = Array.from({ length: 140 }, (_, i) => file(`/assets/${i}.png`, String(i)));
  const blob = await packageZip(files, { version: 2 });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  let active = 0;
  let maxActive = 0;
  const counts = [];
  cache.put = async (key, response) => {
    if (key !== indexUrl(target.store.origin)) return put(key, response);
    active++;
    maxActive = Math.max(maxActive, active);
    counts.push(Object.keys((await response.clone().json()).files).length);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await put(key, response);
    active--;
  };
  assert.equal((await importResourceZip(target.store, blob)).imported, files.length);
  assert.equal(maxActive, 1);
  assert.ok(counts.length >= 3);
  assert.deepEqual(counts, counts.toSorted((a, b) => a - b));
  assert.equal(counts.at(-1), files.length);
  assert.equal((await target.store.status()).count, files.length);
});

test('incremental import counters preserve same-key URL aliases and unknown resource sizes', async () => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'bbb')];
  const unknown = { ...files[1] };
  delete unknown.size;
  const target = store([files[0], { ...files[0], url: 'https://game.example/assets/a.png' }, unknown]);
  const blob = await packageZip(files, { version: 2 });
  const snapshots = [];
  const result = await importResourceZip(target.store, blob, { onProgress: (p) => {
    if (p.getStatus) snapshots.push(p.getStatus());
  } });
  assert.equal(result.imported, 2, 'aliases share a stored URL');
  const actual = await target.store.status();
  const last = snapshots.at(-1);
  assert.deepEqual([last.count, last.bytes, last.sized, last.complete], [actual.count, actual.bytes, actual.sized, actual.complete]);
  assert.deepEqual(last.groups, actual.groups);
  assert.deepEqual([last.count, last.bytes, last.sized], [3, 2, 2]);
});

test('a late invalid digest cannot write its bytes or discard a valid file already completed by another lane', async (t) => {
  const files = [file('/assets/a.png', 'a'), file('/assets/b.png', 'b')];
  const blob = await packageZip(files, { mutate: (rows) => { rows[1].sha256 = '0'.repeat(64); } });
  const target = store(files);
  const cache = await target.caches.open(CACHE_NAME);
  const put = cache.put.bind(cache);
  const firstWritten = Promise.withResolvers();
  cache.put = async (key, response) => {
    await put(key, response);
    if (key.endsWith('/a.png')) firstWritten.resolve();
  };
  const generator = ZipReader.prototype.getEntriesGenerator;
  t.mock.method(ZipReader.prototype, 'getEntriesGenerator', async function* (...args) {
    for await (const entry of generator.apply(this, args)) {
      if (entry.filename === 'resources/1') {
        const getData = entry.getData;
        entry.getData = async (...args) => { await firstWritten.promise; return getData(...args); };
      }
      yield entry;
    }
  });
  await assert.rejects(importResourceZip(target.store, blob), /校验失败/);
  assert.equal((await target.store.status()).count, 1);
  assert.equal(await (await cache.match(target.store.keyOf(files[0].url))).text(), 'a');
  assert.equal(await cache.match(target.store.keyOf(files[1].url)), undefined);
});
