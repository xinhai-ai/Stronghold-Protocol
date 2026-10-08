import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceZipReader, ZIP_READ_BLOCK_BYTES as BLOCK, ZIP_READ_CACHE_BYTES as LIMIT } from '../../public/js/resources/zipReader.js';

// A virtual file avoids retaining a second large fixture buffer while exercising real reader boundary behavior.
function virtualFile(size, read) {
  return { size, slice(start, end) { return { async arrayBuffer() {
    await read?.(start, end);
    const bytes = new Uint8Array(Math.min(end, size) - start);
    bytes.fill(Math.floor(start / BLOCK) + 1);
    return bytes.buffer;
  } }; } };
}

test('adjacent requests share a physical file read and return independent byte snapshots', async () => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const reader = new ResourceZipReader(virtualFile(BLOCK * 3, async (start, end) => {
    calls.push([start, end]); started.resolve(); await gate.promise;
  }));
  const first = reader.readUint8Array(100, 30);
  const second = reader.readUint8Array(1000, 4096);
  await started.promise;
  assert.equal(calls.length, 1, 'concurrent reads into the same block share a pending read');
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.buffer.byteLength, a.byteLength, 'entry metadata cannot pin a 16 MiB block');
  assert.equal(b.buffer.byteLength, b.byteLength);
  a.fill(9);
  const again = await reader.readUint8Array(100, 30);
  assert.ok(again.every((n) => n === 1), 'mutating returned bytes cannot mutate the cached file block');
  assert.equal(reader.timings.fileReadCalls, 1);
  assert.equal(reader.timings.maxReadAheadBytes, BLOCK);
});

test('reads crossing block boundaries preserve byte order; LRU cache remains bounded to 32 MiB', async () => {
  assert.equal(LIMIT, 32 * 1024 * 1024);
  const calls = [];
  const reader = new ResourceZipReader(virtualFile(BLOCK * 4 + 11, (start, end) => { calls.push([start, end]); }));
  const crossing = await reader.readUint8Array(BLOCK - 10, 25);
  assert.deepEqual([...crossing], [...Array(10).fill(1), ...Array(15).fill(2)]);
  await reader.readUint8Array(BLOCK * 2 + 10, 30);
  await reader.readUint8Array(BLOCK + 10, 30); // refresh second block
  await reader.readUint8Array(BLOCK * 3 + 10, 30); // evicts third block
  await reader.readUint8Array(BLOCK + 10, 30); // retained second block
  assert.equal(calls.length, 4);
  await reader.readUint8Array(BLOCK * 2 + 10, 30);
  assert.equal(calls.length, 5, 'evicted blocks are read again when needed');
  assert.equal(reader.timings.maxReadAheadBytes, LIMIT);
  const tail = await reader.readUint8Array(BLOCK * 4, 11);
  assert.deepEqual([...tail], Array(11).fill(5));
});

test('oversized requests bypass read-ahead and still enforce file boundaries and actual read sizes', async () => {
  const calls = [];
  const reader = new ResourceZipReader(virtualFile(BLOCK * 4, (start, end) => { calls.push([start, end]); }));
  assert.equal((await reader.readUint8Array(0, BLOCK + 10)).byteLength, BLOCK + 10);
  assert.deepEqual(calls, [[0, BLOCK + 10]]);
  assert.equal(reader.timings.maxReadAheadBytes, 0);
  for (const [offset, length] of [[-1, 10], [0, -1], [0, 0.5], [BLOCK * 4, 1]]) {
    await assert.rejects(reader.readUint8Array(offset, length), /读取边界/);
  }
  const short = new ResourceZipReader({ size: BLOCK, arrayBuffer: async () => new ArrayBuffer(10),
    slice() { return { arrayBuffer: async () => new ArrayBuffer(10) }; } });
  await assert.rejects(short.readUint8Array(0, 30), /文件不完整/);
});

test('aborting during a physical read rejects queued requests without reading further file blocks', async () => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const controller = new AbortController();
  let reads = 0;
  const reader = new ResourceZipReader(virtualFile(BLOCK * 3, async () => {
    reads++; started.resolve(); await gate.promise;
  }), controller.signal);
  const first = reader.readUint8Array(0, 30);
  const next = reader.readUint8Array(BLOCK, 30);
  const observed = Promise.allSettled([first, next]);
  await started.promise;
  controller.abort();
  gate.resolve();
  const outcomes = await observed;
  assert.ok(outcomes.every((r) => r.status === 'rejected' && r.reason.name === 'AbortError'));
  assert.equal(reads, 1);
  assert.equal(reader.timings.maxReadAheadBytes, 0);
});
