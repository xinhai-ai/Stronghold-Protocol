import { BlobReader } from '../../vendor/zip.module.js';
import { checkAbort } from './common.js';

export const ZIP_READ_BLOCK_BYTES = 16 * 1024 * 1024;
export const ZIP_READ_CACHE_BYTES = 2 * ZIP_READ_BLOCK_BYTES;
const BLOCK_BYTES = ZIP_READ_BLOCK_BYTES;
const SMALL_READ_BYTES = BLOCK_BYTES;
const MAX_BLOCKS = 2;

/** Share file reads across adjacent headers and stored bodies. Returned arrays never retain/alias cache blocks. */
export class ResourceZipReader extends BlobReader {
  constructor(blob, signal) {
    super(blob);
    this.signal = signal;
    this.blocks = new Map();
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.timings = { fileReadCalls: 0, fileReadBytes: 0, fileReadMs: 0, maxReadAheadBytes: 0,
      readBlockBytes: ZIP_READ_BLOCK_BYTES, readCacheLimitBytes: ZIP_READ_CACHE_BYTES };
  }

  async readUint8Array(offset, length) {
    checkAbort(this.signal);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > this.size) throw new Error('ZIP 文件读取边界无效');
    if (length > SMALL_READ_BYTES) return this.readFile(offset, length);
    const result = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      const position = offset + copied;
      const blockOffset = Math.floor(position / BLOCK_BYTES) * BLOCK_BYTES;
      const block = await this.readBlock(blockOffset);
      checkAbort(this.signal);
      const start = position - blockOffset;
      const count = Math.min(length - copied, block.byteLength - start);
      if (count <= 0) throw new Error('ZIP 文件不完整');
      result.set(block.subarray(start, start + count), copied);
      copied += count;
    }
    return result;
  }

  cachedBlock(offset) {
    const bytes = this.blocks.get(offset);
    if (bytes) { this.blocks.delete(offset); this.blocks.set(offset, bytes); }
    return bytes;
  }

  readBlock(offset) {
    const cached = this.cachedBlock(offset);
    if (cached) return Promise.resolve(cached);
    if (this.pending.has(offset)) return this.pending.get(offset);
    // Only one physical read-ahead runs at once; concurrent requests for the same block share its promise.
    const reading = this.queue.then(async () => {
      checkAbort(this.signal);
      const hit = this.cachedBlock(offset);
      if (hit) return hit;
      if (this.blocks.size >= MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value);
      const bytes = await this.readFile(offset, Math.min(BLOCK_BYTES, this.size - offset));
      this.blocks.set(offset, bytes);
      this.timings.maxReadAheadBytes = Math.max(this.timings.maxReadAheadBytes,
        [...this.blocks.values()].reduce((n, block) => n + block.byteLength, 0));
      return bytes;
    }).finally(() => this.pending.delete(offset));
    this.pending.set(offset, reading);
    this.queue = reading.then(() => {}, () => {});
    return reading;
  }

  async readFile(offset, length) {
    checkAbort(this.signal);
    const start = performance.now();
    this.timings.fileReadCalls++;
    try {
      const bytes = await super.readUint8Array(offset, length);
      this.timings.fileReadBytes += bytes.byteLength;
      checkAbort(this.signal);
      if (bytes.byteLength !== length) throw new Error('ZIP 文件不完整');
      return bytes;
    } finally { this.timings.fileReadMs += performance.now() - start; }
  }
}
