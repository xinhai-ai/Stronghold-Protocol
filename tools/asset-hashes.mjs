#!/usr/bin/env node
// tools/asset-hashes.mjs — per-file content hashes of the fetched assets (docs/ASSETS.md「Preload」).
//
// Why this file exists: the optional asset preload stores a file until its *content* changes. The client cannot ask
// Cache Storage "did the bytes at this URL change?", so the server hands it a hash per file and it re-downloads only
// the entries whose hash differs — an asset update costs the changed files instead of the whole ~310 MiB
// (server/resources.js, public/js/resources/store.js). Local-client art gets its hash from extract.py; this tool
// covers everything else (tools/fetch-assets.mjs → public/assets/**, public/fonts/**).
//
// Run it on the machine that holds the assets (usually the one that uploads them to the CDN, right after
// `npm run assets`), then ship the result with the asset manifests:
//
//   node tools/asset-hashes.mjs                 # → data/asset-hashes.json
//   node tools/asset-hashes.mjs --check         # validate only: exit 1 when the file is missing or stale
//   node tools/asset-hashes.mjs --out /tmp/h.json --concurrency 8
//
// Without the file the server still serves a complete preload manifest: every entry falls back to a synthetic hash of
// the source manifest's own hash/mtime, i.e. the pre-hash behaviour (an update re-downloads everything).
//
// The digest is the first 12 hex characters of the SHA-1 of the file's bytes — the same shape as the hashes in
// data/local-assets.json. Files are read as streams with a few lanes in flight: hashing ~250 MiB stays at a couple of
// hundred MiB of RSS, never a copy of the asset tree.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HASHES_VERSION = 1;
/** The trees the preload may cache (server/resources.js isResourcePath) — the same ones this tool hashes. */
export const TREES = ['public/assets', 'public/fonts'];
/** Suffixes worth hashing as resources; mirrors the server's RESOURCE_MIME keys (a `.json` sidecar is never preloaded). */
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp3', 'ogg', 'wav', 'm4a', 'mp4', 'woff', 'woff2', 'ttf', 'otf', 'css', 'atlas', 'obj', 'skel', 'bin']);

/** Recursively list the resource files under `dir`, as site paths (`/assets/ui/x.png`). */
export async function listResourceFiles(dir, { root = ROOT } = {}) {
  const out = [];
  const walk = async (abs) => {
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) { await walk(child); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      out.push('/' + path.relative(path.join(root, 'public'), child).split(path.sep).join('/'));
    }
  };
  await walk(path.resolve(root, dir));
  return out;
}

/** SHA-1 of a file's bytes, first 12 hex characters. Streams: the file never enters memory as a whole. */
export async function hashFile(abs) {
  const hash = crypto.createHash('sha1');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 1 << 20 })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { hash: hash.digest('hex').slice(0, 12), bytes };
}

/**
 * Hash every resource file of the asset trees.
 * @param {{ root?: string, trees?: string[], concurrency?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<{ files: Record<string, string>, bytes: number, count: number, missing: string[] }>}
 */
export async function collectHashes({ root = ROOT, trees = TREES, concurrency = 4, onProgress = null } = {}) {
  const lists = await Promise.all(trees.map((t) => listResourceFiles(t, { root })));
  const urls = lists.flat().sort();
  /** @type {Record<string, string>} */
  const files = {};
  const missing = [];
  let bytes = 0;
  let done = 0;
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, urls.length || 1));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let i = next++; i < urls.length; i = next++) {
      const url = urls[i];
      const abs = path.join(root, 'public', url.slice(1));
      try {
        const { hash, bytes: n } = await hashFile(abs);
        files[url] = hash;
        bytes += n;
      } catch (err) {
        if (err && err.code === 'ENOENT') missing.push(url);
        else throw err;
      }
      onProgress?.(++done, urls.length);
    }
  }));
  return { files, bytes, count: Object.keys(files).length, missing };
}

/** The document written to data/asset-hashes.json (sorted keys: a rebuild with no change is a no-op diff). */
export function hashesDoc({ files, count, bytes }) {
  const sorted = {};
  for (const url of Object.keys(files).sort()) sorted[url] = files[url];
  return { version: HASHES_VERSION, generator: 'tools/asset-hashes.mjs', count, bytes, files: sorted };
}

function parseArgs(argv) {
  const o = { out: path.join(ROOT, 'data', 'asset-hashes.json'), check: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--out') o.out = path.resolve(argv[++i] || '');
    else if (a.startsWith('--out=')) o.out = path.resolve(a.slice(6));
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (a.startsWith('--concurrency=')) o.concurrency = Math.max(1, Number(a.slice(14)) || 4);
    else if (a === '--help' || a === '-h') { console.log('usage: node tools/asset-hashes.mjs [--out data/asset-hashes.json] [--check] [--concurrency 4]'); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const res = await collectHashes({ concurrency: opt.concurrency });
  const doc = hashesDoc(res);
  const body = JSON.stringify(doc, null, 2) + '\n';
  let prev = null;
  try { prev = await fsp.readFile(opt.out, 'utf8'); } catch { /* no previous file */ }
  const same = prev !== null && prev === body;
  const mib = (res.bytes / 1048576).toFixed(1);
  if (opt.check) {
    if (prev === null) { console.error(`missing ${path.relative(ROOT, opt.out)} — run node tools/asset-hashes.mjs`); process.exit(1); }
    if (!same) { console.error(`${path.relative(ROOT, opt.out)} is stale — re-run node tools/asset-hashes.mjs`); process.exit(1); }
    console.log(`ok: ${res.count} file(s), ${mib} MiB, ${path.relative(ROOT, opt.out)} is up to date (${Date.now() - t0} ms)`);
    return;
  }
  if (same) { console.log(`unchanged: ${res.count} file(s), ${mib} MiB, ${path.relative(ROOT, opt.out)} (${Date.now() - t0} ms)`); return; }
  await fsp.mkdir(path.dirname(opt.out), { recursive: true });
  await fsp.writeFile(opt.out, body);
  console.log(`wrote ${path.relative(ROOT, opt.out)}: ${res.count} file(s), ${mib} MiB, ${Date.now() - t0} ms`);
  if (res.missing.length) console.log(`  ${res.missing.length} listed file(s) were missing on disk (skipped)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('asset-hashes.mjs')) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
