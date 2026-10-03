// public/js/resources/service.js — the Service Worker side of the asset preload: answer a request from Cache Storage, or
// say "not mine" so the worker falls back to the network (docs/ASSETS.md「Preload」).
//
// Only /assets/** and /fonts/** (site paths or CDN URLs) are ever answered, and only from caches this app wrote
// (`X-SP-Resource`): code, data, API responses, manifests and WebSocket traffic never pass through this module.

import { CACHE_NAME, CACHE_PREFIX, CONTENT_HASH_RE, isResourcePath, rangeResponse } from './common.js';

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
  const hit = await matchResource(request.url, caches);
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
 * First cache entry for a URL across every cache this app owns: the current cache first, then the caches of earlier
 * builds (the pre-hash layout). Those are still answered while an update migrates them into `CACHE_NAME` — and the
 * order matters, because a stale entry left in an older cache must never shadow the fresh file of the current one.
 */
async function matchResource(url, caches) {
  const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
  names.sort((a, b) => (a === CACHE_NAME ? -1 : b === CACHE_NAME ? 1 : 0));
  for (const name of names) {
    const cache = await caches.open(name);
    const res = await cache.match(url);
    if (res) return res;
  }
  return null;
}
