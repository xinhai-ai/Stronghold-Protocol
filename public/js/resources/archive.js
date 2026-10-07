// Lazy ZIP support. Packages describe bytes, never executable code or trusted cache index records.
// Only the CURRENT server manifest can authorize an imported resource; old packages may contribute unchanged files.
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '../../vendor/zip.module.js';
import { CONTENT_HASH_RE, MAX_FILE_BYTES, checkAbort, isResourceUrl, resourceType } from './common.js';

export const ARCHIVE_MANIFEST = 'stronghold-resources.json';
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 50000;
const OPTIONS = { useWebWorkers: false };
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashes(blob) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持资源校验');
  const bytes = await blob.arrayBuffer();
  return {
    sha256: hex(await crypto.subtle.digest('SHA-256', bytes)),
    hash: hex(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 12),
  };
}

/** Stable resource identity across origins/CDN prefixes; only current manifest URLs are ever cache destinations. */
export function resourcePath(url) {
  if (!isResourceUrl(url)) throw new Error('资源路径无效');
  const path = new URL(url, 'https://archive.invalid').pathname;
  const match = /\/(?:assets|fonts)\//.exec(path);
  if (!match) throw new Error('资源路径无效');
  const canonical = path.slice(match.index);
  let decoded;
  try { decoded = decodeURIComponent(canonical); } catch { throw new Error('资源路径无效'); }
  if (/[\\\u0000-\u001f?#]/.test(decoded) || decoded.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('资源路径无效');
  }
  return canonical;
}

/** Enforce the limit on actual decompressed bytes as well as untrusted central-directory sizes. */
async function extract(entry, limit, signal) {
  checkAbort(signal);
  if (entry.encrypted || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limit) {
    throw new Error(`ZIP 文件大小超限或已加密：${entry.filename}`);
  }
  const chunks = [];
  let size = 0;
  await entry.getData(new WritableStream({
    write(chunk) {
      checkAbort(signal);
      size += chunk.byteLength;
      if (size > limit || size > entry.uncompressedSize) throw new Error(`ZIP 解压大小超限：${entry.filename}`);
      chunks.push(chunk);
    },
  }), { ...OPTIONS, signal, checkSignature: true, checkOverlappingEntry: true });
  if (size !== entry.uncompressedSize) throw new Error(`ZIP 文件不完整：${entry.filename}`);
  return new Blob(chunks);
}

export async function exportResourceZip(store, { signal, onProgress } = {}) {
  checkAbort(signal);
  const status = await store.status();
  const files = store.files.filter((f) => store.eligible(f) && status.present.has(store.keyOf(f.url)));
  if (!files.length) throw new Error('没有已缓存的资源，请先预载或导入资源');
  const cache = await store.caches.open(store.cacheName);
  const writer = new ZipWriter(new BlobWriter('application/zip'), { ...OPTIONS, level: 0 });
  const rows = [];
  let total = 0;
  try {
    onProgress?.({ phase: 'export', done: 0, total: files.length });
    for (const file of files) {
      checkAbort(signal);
      const response = await cache.match(store.keyOf(file.url));
      if (!response || response.type === 'opaque' || !response.ok) throw new Error('缓存资源不可读取，请重新预载');
      const chunks = [];
      let size = 0;
      await response.body.pipeTo(new WritableStream({ write(chunk) {
        checkAbort(signal);
        size += chunk.byteLength;
        if (size > MAX_FILE_BYTES) throw new Error(`资源大小超限：${file.url}`);
        chunks.push(chunk);
      } }), { signal });
      const blob = new Blob(chunks);
      total += blob.size;
      if (total > MAX_ARCHIVE_BYTES - MAX_MANIFEST_BYTES) throw new Error('资源包超过 2 GiB，请减少预载资源后导出');
      const digest = await hashes(blob);
      if (CONTENT_HASH_RE.test(file.hash || '') && digest.hash !== file.hash) {
        throw new Error(`缓存资源校验失败，请清理后重新预载：${file.url}`);
      }
      const path = `resources/${rows.length}`;
      rows.push({ path, url: resourcePath(file.url), hash: digest.hash, sha256: digest.sha256, size: blob.size });
      await writer.add(path, new BlobReader(blob), { signal });
      onProgress?.({ phase: 'export', done: rows.length, total: files.length });
    }
    const manifest = new Blob([JSON.stringify({ format: 'stronghold-resource-zip', version: 1,
      resourceVersion: store.manifest.version, files: rows })]);
    if (manifest.size > MAX_MANIFEST_BYTES) throw new Error('资源包清单过大');
    await writer.add(ARCHIVE_MANIFEST, new BlobReader(manifest), { signal });
    const blob = await writer.close();
    if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('资源包超过 2 GiB');
    return { blob, count: rows.length, version: store.manifest.version };
  } catch (err) {
    // The partial ZIP never escapes to the UI.
    await writer.close().catch(() => {});
    throw err;
  }
}

export async function importResourceZip(store, blob, { signal, onProgress } = {}) {
  if (!blob || typeof blob.slice !== 'function' || !Number.isSafeInteger(blob.size) || blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error('请选择不超过 2 GiB 的资源 ZIP 包');
  }
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持资源校验');
  const reader = new ZipReader(new BlobReader(blob), { ...OPTIONS, checkSignature: true });
  try {
    const entries = new Map();
    let total = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(signal);
      if (entries.size >= MAX_FILES + 1) throw new Error('ZIP 文件数量超限');
      if (entries.has(entry.filename)) throw new Error('ZIP 包包含重复路径');
      if (entry.directory || entry.encrypted || (entry.filename !== ARCHIVE_MANIFEST && !/^resources\/\d{1,5}$/.test(entry.filename))) {
        throw new Error(`ZIP 包包含无效路径或加密文件：${entry.filename}`);
      }
      const limit = entry.filename === ARCHIVE_MANIFEST ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limit) {
        throw new Error('ZIP 解压大小超限');
      }
      total += entry.uncompressedSize;
      if (total > MAX_ARCHIVE_BYTES) throw new Error('ZIP 解压总大小超限');
      entries.set(entry.filename, entry);
    }
    const manifestEntry = entries.get(ARCHIVE_MANIFEST);
    if (!manifestEntry) throw new Error('ZIP 包缺少预载资源清单，请使用本功能导出的资源包');
    const doc = JSON.parse(await (await extract(manifestEntry, MAX_MANIFEST_BYTES, signal)).text());
    if (doc?.format !== 'stronghold-resource-zip' || doc.version !== 1 || !Array.isArray(doc.files)
      || doc.files.length > MAX_FILES || !doc.files.length) throw new Error('资源包清单格式不受支持');
    if (entries.size !== doc.files.length + 1) throw new Error('资源包清单与文件数量不一致');

    const paths = new Set();
    const urls = new Set();
    for (const row of doc.files) {
      if (!row || typeof row.path !== 'string' || !/^resources\/\d{1,5}$/.test(row.path) || paths.has(row.path)
        || typeof row.url !== 'string' || resourcePath(row.url) !== row.url || urls.has(row.url)
        || typeof row.hash !== 'string' || !CONTENT_HASH_RE.test(row.hash) || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)
        || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_FILE_BYTES
        || entries.get(row.path)?.uncompressedSize !== row.size) throw new Error('资源包清单条目无效或缺少文件');
      paths.add(row.path);
      urls.add(row.url);
    }

    // Validate EVERY file before changing the live cache. Two passes avoid a second, large staging cache and keep
    // memory bounded to one resource (24 MiB). Corrupt packages cannot partially overwrite working resources.
    let checked = 0;
    onProgress?.({ phase: 'verify', done: 0, total: doc.files.length });
    for (const row of doc.files) {
      const data = await extract(entries.get(row.path), MAX_FILE_BYTES, signal);
      const digest = await hashes(data);
      if (digest.hash !== row.hash || digest.sha256 !== row.sha256) throw new Error(`资源包校验失败：${row.url}`);
      onProgress?.({ phase: 'verify', done: ++checked, total: doc.files.length });
    }
    const available = new Map(doc.files.map((row) => [`${row.url}|${row.hash}`, row]));
    const compatible = store.files.filter((f) => store.eligible(f) && CONTENT_HASH_RE.test(f.hash || '')
      && available.has(`${resourcePath(f.url)}|${f.hash}`)
      && (f.size == null || f.size === available.get(`${resourcePath(f.url)}|${f.hash}`).size));
    onProgress?.({ phase: 'import', done: 0, total: compatible.length });
    const outcome = await store.importFiles(compatible, {
      signal,
      read: async (file) => {
        const row = available.get(`${resourcePath(file.url)}|${file.hash}`);
        const data = await extract(entries.get(row.path), MAX_FILE_BYTES, signal);
        return new Response(data, { headers: { 'Content-Type': resourceType(file.url), 'Content-Length': String(data.size) } });
      },
      onProgress: ({ processed, file, getStatus }) => onProgress?.({ phase: 'import', done: processed,
        total: compatible.length, file, getStatus }),
    });
    return { ...outcome, packageCount: doc.files.length, compatible: compatible.length,
      skippedPackage: doc.files.length - new Set(compatible.map((f) => resourcePath(f.url))).size };
  } finally {
    await reader.close();
  }
}
