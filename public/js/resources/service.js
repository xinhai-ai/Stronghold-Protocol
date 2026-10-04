// public/js/resources/service.js — the Service Worker side of the asset preload: answer a request from Cache Storage, or
// say "not mine" so the worker falls back to the network (docs/ASSETS.md「Preload」).
//
// Only /assets/**, /fonts/** and the extension-less /media/** audio route (site paths or CDN URLs) are ever answered, and
// only from caches this app wrote (`X-SP-Resource`): code, data, API responses, manifests and WebSocket traffic never
// pass through this module.

import { CACHE_NAME, CACHE_PREFIX, CONTENT_HASH_RE, isResourcePath, mediaCandidates, rangeResponse } from './common.js';

/**
 * @param {Request} request
 * @param {{ caches?: any }} [opts]
 * @returns {Promise<Response|null>} a cached reply, or null when the request is not a cached resource
 */
export async function handleResourceRequest(request, { caches = globalThis.caches } = {}) {
  if (!caches || !request || request.method !== 'GET') return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (!isResourcePath(url.pathname)) return null;
  const hit = await matchResource(url, caches);
  if (!hit) return null;
  const range = request.headers.get('Range');
  if (!range) return hit;
  try {
    return await rangeResponse(hit, range);
  } catch {
    return hit; // a range we cannot slice falls back to the whole file (a 200 is valid for any request)
  }
}

/**
 * The cache keys a request may be answered from. Usually just its own URL — but the game fetches audio through the
 * extension-less `/media/bgm/act1` route (shared/media.js, `server/index.js serveMedia`), and the preload stores the
 * canonical `/assets/audio/….mp3` the manifest lists, so such a request also looks for those.
 * @param {URL} url
 * @returns {string[]}
 */
function cacheKeys(url) {
  const candidates = mediaCandidates(url.pathname);
  if (!candidates.length) return [url.href];
  const keys = [];
  for (const path of candidates) {
    try { keys.push(new URL(path, url).href); } catch { /* one impossible candidate less */ }
  }
  return keys.length ? keys : [url.href];
}

/**
 * First cache entry for a request across every cache this app owns: the current cache first, then the caches of earlier
 * builds (the pre-hash layout). Those are still answered while an update migrates them into `CACHE_NAME` — and the
 * order matters, because a stale entry left in an older cache must never shadow the fresh file of the current one.
 */
async function matchResource(url, caches) {
  const keys = cacheKeys(url);
  const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
  names.sort((a, b) => (a === CACHE_NAME ? -1 : b === CACHE_NAME ? 1 : 0));
  for (const name of names) {
    const cache = await caches.open(name);
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const res = await cache.match(key);
      if (res) return res;
    }
  }
  return null;
}
