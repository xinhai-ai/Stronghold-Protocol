// public/resource-sw.js — the optional offline-resource Service Worker (docs/ASSETS.md「Preload」).
//
// Registered with `type: 'module'` by public/js/resources/index.js when the player turns the preload on (设置 ▸ 离线资源)
// and unregistered when they turn it off. Its scope is "/", but it only ever touches GET requests for `/assets/**` and
// `/fonts/**` (site paths or CDN URLs): code, game data, API calls and WebSocket upgrades pass straight through to the
// network, so a stale worker can never serve a stale game.

import { handleResourceRequest } from './js/resources/service.js';

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!/\/(?:assets|fonts)\//.test(url.pathname)) return;
  event.respondWith(handleResourceRequest(request).then((cached) => cached || fetch(request)).catch(() => fetch(request)));
});
