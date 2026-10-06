// render/boardArt.js — optional real board art from the local game client (DESIGN §13).
//
//   const art = await loadBoardArt(assets)   // null when the art (or its crop table) is not installed
//   → { key, tiles, images: { D, common?, BG? } }   (tiles = tiles.json of tools/crop-board-atlas.mjs)
//
// Discovery never guesses URLs: the local-art manifest (data/local-assets.json, assets.local()) must list the atlas
// `map/autochess → TX_autochessi_D`; its crop table `tiles.json` sits next to it (written by
// tools/crop-board-atlas.mjs). Every image referenced by the table is loaded through the shared image cache; a
// missing image drops only the materials that use it. Everything is cached per page (one load for every view).

import { ASSETS_CDN } from '../asset-cdn.js';
import { rewriteAssetPaths } from '../../../shared/cdn.js';

let cached = null;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {any} assets store of public/js/assets.js (needs local(), localUrl(), image())
 * @param {{ assetsCdn?: string }} [options] runtime CDN by default; injectable for tests.
 */
export function loadBoardArt(assets, { assetsCdn = ASSETS_CDN } = {}) {
  if (cached) return cached;
  cached = (async () => {
    if (!assets || typeof assets.local !== 'function' || typeof assets.image !== 'function') return null;
    const manifest = await assets.local().catch(() => null);
    if (!manifest) return null;
    const atlasUrl = assets.localUrl ? assets.localUrl('map/autochess', 'TX_autochessi_D') : null;
    if (!atlasUrl) return null;
    const dir = atlasUrl.replace(/\/[^/]*$/, '');
    let tiles = null;
    try {
      const res = await fetch(`${dir}/tiles.json`, { cache: 'no-cache' });
      tiles = res.ok ? await res.json() : null;
    } catch { tiles = null; }
    if (!isObj(tiles) || !isObj(tiles.materials) || !isObj(tiles.source)) return null;
    // The crop table is a static JSON sidecar, so its root-relative image paths need the same rewrite as manifests.
    rewriteAssetPaths(tiles.source, assetsCdn);
    const images = {};
    await Promise.all(Object.entries(tiles.source).map(async ([k, s]) => {
      const url = isObj(s) && typeof s.path === 'string' ? s.path : null;
      if (!url) return;
      const img = await assets.image(url).catch(() => null);
      if (img && img.width > 0) images[k] = img;
    }));
    if (!images.D) return null;
    return { key: `${atlasUrl}#${tiles.version || 0}`, tiles, images };
  })().catch(() => null);
  return cached;
}

/** Forget the cached art (tests / hot reload). */
export function resetBoardArt() { cached = null; }
