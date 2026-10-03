// server/resources.js — the optional preload manifest (docs/ASSETS.md「Preload」).
//
// The client can preload every file a match may need into Cache Storage (Service Worker, public/js/resources/*), so
// entering a battle never waits on a download: the art comes from the browser cache.
// That list needs no extra build step: it is derived from the asset manifests this server already serves, and it is
// rewritten exactly like /data/assets.json (SP_ASSETS_CDN, docs/ASSETS.md「CDN」) — so the client preloads from the
// CDN. Local file sizes are added when this install has the files on disk (a CDN-only install simply omits them).
//
// /data/resource-manifest.json:
//   { format: 1, version: '<assets hash>-<local hash>-<cdn base>', count, tier1, sized, totalBytes,
//     files: [ { url, tier, size? } … ] }   // sorted: essential tier first, then by URL

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const RESOURCE_MANIFEST_FILE = 'resource-manifest.json';
export const RESOURCES_FORMAT = 1;
/** A single cached file may never exceed this (a broken manifest cannot make a browser store something huge). */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
/** Essential: fonts, UI, icons, avatars, audio — what a screen needs in its first second. */
export const TIER_ESSENTIAL = 1;
/** The rest: portraits, Spine models, local-client board art — big, fetched in the background. */
export const TIER_REST = 2;

/** Extension → MIME type. Mirrored by the client (public/js/resources/common.js) for URL validation. */
export const RESOURCE_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css; charset=utf-8',
  atlas: 'text/plain; charset=utf-8',
  obj: 'text/plain; charset=utf-8',
  skel: 'application/octet-stream',
  bin: 'application/octet-stream',
});

/** MIME type of a resource URL, or null when the extension is not a resource type. */
export function resourceType(url) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(url || ''));
  return m ? RESOURCE_MIME[m[1].toLowerCase()] || null : null;
}

/** Whether a URL path is served from the asset trees the preload may cache. */
export function isResourcePath(pathname) {
  return /\/(?:assets|fonts)\//.test(String(pathname || ''));
}

/**
 * Whether a manifest string is a file the client may request: a site path (`/assets/…`, `/fonts/…`) or an absolute
 * http(s) URL (the CDN shape), with a known resource extension and no query/control characters.
 */
export function validateResourceUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) return false;
  if (/[\s?#\\"'<>\u0000-\u001f]/.test(url)) return false;
  let pathname = url;
  if (!url.startsWith('/') || url.startsWith('//')) {
    if (!/^https?:\/\//i.test(url)) return false;
    try { pathname = new URL(url).pathname; } catch { return false; }
  }
  return isResourcePath(pathname) && !!resourceType(pathname);
}

const TIER_ESSENTIAL_SECTIONS = new Set(['ui', 'prof', 'bonds', 'items', 'bands', 'skills', 'audio', 'fonts']);

/**
 * Preload tier of a manifest entry, from its key path (`chars.char_002_amiya.spine.front.skel`). Operators, tokens and
 * enemies are split by role — their avatars/icons are essential, portraits and Spine models are the bulk; local-client
 * art is essential only for the board (`map`), everything else is background. Unknown sections default to the
 * background tier: the fast path must stay fast even if the manifest grows a new section.
 */
export function tierForPath(keyPath) {
  const p = String(keyPath || '');
  const head = p.split('.')[0];
  if (head === 'chars' || head === 'tokens' || head === 'enemies') return /(^|\.)(?:spine|portrait)/.test(p) ? TIER_REST : TIER_ESSENTIAL;
  if (head === 'local') return /(^|\.)map(\.|$)/.test(p) ? TIER_ESSENTIAL : TIER_REST;
  return TIER_ESSENTIAL_SECTIONS.has(head) ? TIER_ESSENTIAL : TIER_REST;
}

/**
 * Every resource file of the asset manifests, deduplicated (a file keeps its lowest tier) and sorted essential-first.
 * @param {any} assets parsed data/assets.json (already CDN-rewritten)
 * @param {any} local parsed data/local-assets.json, optional
 * @returns {{ url: string, tier: number }[]}
 */
export function collectResourceFiles(assets, local) {
  /** @type {Map<string, number>} */
  const byUrl = new Map();
  const walk = (node, keyPath) => {
    if (typeof node === 'string') {
      if (!validateResourceUrl(node)) return;
      const tier = tierForPath(keyPath);
      const prev = byUrl.get(node);
      if (prev == null || tier < prev) byUrl.set(node, tier);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${keyPath}.${i}`);
      return;
    }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, keyPath ? `${keyPath}.${k}` : k);
  };
  for (const [k, v] of Object.entries(assets && typeof assets === 'object' ? assets : {})) {
    if (k === 'stats' || k === 'skillsById') continue; // counters / id maps: no files
    walk(v, k);
  }
  if (local && typeof local === 'object') walk(local, 'local');
  return [...byUrl].map(([url, tier]) => ({ url, tier })).sort((a, b) => a.tier - b.tier || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * The manifest body. `sizes` (URL → bytes) is optional: without it the client still preloads, it just reports progress
 * in files instead of bytes.
 */
export function buildResourceManifest({ files, sizes = null, version = 'none' }) {
  let totalBytes = 0;
  let sized = 0;
  let tier1 = 0;
  const out = [];
  for (const f of files) {
    const size = sizes ? sizes.get(f.url) : undefined;
    const entry = { url: f.url, tier: f.tier };
    if (Number.isSafeInteger(size) && size >= 0) {
      entry.size = size;
      totalBytes += size;
      sized++;
    }
    if (f.tier === TIER_ESSENTIAL) tier1++;
    out.push(entry);
  }
  return {
    format: RESOURCES_FORMAT,
    version: String(version),
    count: out.length,
    tier1,
    sized,
    totalBytes: sized ? totalBytes : null,
    files: out,
  };
}

/**
 * Absolute path of a resource URL inside this install, or null when the URL is not a site path / escapes publicDir.
 * A CDN URL maps back to the same tree (`https://cdn/assets/x.png` → `<publicDir>/assets/x.png`).
 */
export function localPathFor(url, publicDir, cdnBase = '') {
  let p = String(url || '');
  if (cdnBase && p.startsWith(cdnBase)) p = p.slice(cdnBase.length) || '/';
  if (!p.startsWith('/')) return null;
  const root = path.resolve(publicDir);
  const segments = p.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const abs = path.join(root, ...segments);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * The served resource manifest, built from the data directory and cached until one of its sources changes.
 * @param {{ dataDir: string, publicDir: string, cdnBase?: string, rewrite?: (v: any) => any,
 *           statFile?: (p: string) => Promise<{ isFile(): boolean, size: number }>, log?: any }} opts
 */
export function createResourceIndex({ dataDir, publicDir, cdnBase = '', rewrite = (v) => v, statFile = (p) => fsp.stat(p), log = null } = {}) {
  /** @type {{ key: string, body: Buffer, gzip: Buffer, mtimeMs: number, manifest: any } | null} */
  let cache = null;

  async function readJson(name) {
    const file = path.join(dataDir, name);
    try {
      const stat = await statFile(file);
      if (!stat.isFile()) return null;
      return { doc: JSON.parse(await fsp.readFile(file, 'utf8')), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
      throw e;
    }
  }

  /** File sizes of the files present on disk (bounded concurrency: ~4 000 stats of a real install). */
  async function measure(files) {
    const sizes = new Map();
    let next = 0;
    const lanes = Math.min(24, files.length);
    await Promise.all(Array.from({ length: lanes }, async () => {
      for (let i = next++; i < files.length; i = next++) {
        const abs = localPathFor(files[i].url, publicDir, cdnBase);
        if (!abs) continue;
        try {
          const stat = await statFile(abs);
          if (stat.isFile()) sizes.set(files[i].url, stat.size);
        } catch { /* not on disk (CDN-only install) — the client preloads it without a size */ }
      }
    }));
    return sizes;
  }

  async function build() {
    const assets = await readJson('assets.json');
    const local = await readJson('local-assets.json');
    const key = [assets ? `${assets.mtimeMs}:${assets.size}` : '-', local ? `${local.mtimeMs}:${local.size}` : '-', cdnBase].join('|');
    if (cache && cache.key === key) return cache;
    const t0 = Date.now();
    const assetsDoc = assets ? rewrite(assets.doc) : null;
    const localDoc = local ? rewrite(local.doc) : null;
    const files = collectResourceFiles(assetsDoc, localDoc);
    const version = [
      assetsDoc && assetsDoc.hash ? assetsDoc.hash : assets ? `m${Math.floor(assets.mtimeMs)}` : 'none',
      localDoc && localDoc.hash ? localDoc.hash : local ? `l${Math.floor(local.mtimeMs)}` : '',
      cdnBase || '',
    ].filter(Boolean).join('-');
    const manifest = buildResourceManifest({ files, sizes: await measure(files), version });
    const body = Buffer.from(JSON.stringify(manifest));
    cache = { key, body, gzip: zlib.gzipSync(body), mtimeMs: Date.now(), manifest };
    log?.info?.(`[resources] ${manifest.count} file(s), ${manifest.tier1} essential, ${manifest.sized} sized`
      + `${manifest.totalBytes ? `, ${(manifest.totalBytes / 1048576).toFixed(1)} MiB` : ''} (${Date.now() - t0} ms)`);
    return cache;
  }

  return {
    /** @returns {Promise<{ body: Buffer, gzip: Buffer, mtimeMs: number, manifest: any }>} */
    get: build,
    /** Drop the cache (tests). */
    reset() { cache = null; },
  };
}
