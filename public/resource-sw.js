// public/resource-sw.js — the optional asset-preload Service Worker (docs/ASSETS.md「Preload」).
//
// Registered with `type: 'module'` by public/js/resources/index.js when the player turns the preload on (设置 ▸ 预载资源)
// and unregistered when they turn it off. Its scope is "/", but it only ever touches GET requests for the resource trees
// (`/assets/**`, `/fonts/**`, and the extension-less `/media/**` audio route the game asks audio through — site paths or
// CDN URLs): code, game data, API calls and WebSocket upgrades pass straight through to the network, so a stale worker
// can never serve a stale game.

import { isResourcePath } from './js/resources/common.js';
import { handleResourceRequest } from './js/resources/service.js';

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!isResourcePath(url.pathname)) return;
  event.respondWith(handleResourceRequest(request).then((cached) => cached || fetch(request)).catch(() => fetch(request)));
});
