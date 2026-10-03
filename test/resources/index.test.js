// test/resources/index.test.js — the preload controller (public/js/resources/index.js, docs/ASSETS.md「Preload」):
// settings → manifest → Service Worker → Cache Storage, with the browser APIs (fetch, caches, navigator.serviceWorker,
// localStorage) stubbed. One test walks the whole lifecycle, because the controller is a module-level singleton.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_PREFIX, cacheName, MANIFEST_URL, SW_URL } from '../../public/js/resources/common.js';

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, response.clone()); }
  async match(request) { const hit = this.entries.get(typeof request === 'string' ? request : request.url); return hit ? hit.clone() : undefined; }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(request) { return this.entries.delete(typeof request === 'string' ? request : request.url); }
}
class MemoryCaches {
  constructor() { this.map = new Map(); }
  async open(name) { if (!this.map.has(name)) this.map.set(name, new MemoryCache()); return this.map.get(name); }
  async keys() { return [...this.map.keys()]; }
  async delete(name) { return this.map.delete(name); }
}

const ORIGIN = 'https://game.example';
const FILES = [
  // the real manifest is sorted essential-first (server/resources.js) — the fixture mirrors that
  { url: '/assets/audio/bgm.mp3', tier: 1, size: 6 },
  { url: '/assets/ui/panel.png', tier: 1, size: 4 },
  { url: '/assets/char/portrait.png', tier: 2, size: 5 },
  { url: '/assets/spine/op/x/front/x.skel', tier: 2, size: 7 },
];
const MANIFEST = { format: 1, version: 'testversion', count: FILES.length, tier1: 2, sized: FILES.length, totalBytes: 22, files: FILES };

/** Install stubs and return the recorder of what the module did. */
function stubEnv({ manifest = MANIFEST, fail = false, secure = true } = {}) {
  const calls = { fetch: [], registered: [], unregistered: 0, released: [] };
  const globals = ['fetch', 'caches', 'navigator', 'isSecureContext', 'location'];
  const saved = Object.fromEntries(globals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const restore = () => {
    for (const k of globals) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
  const caches = new MemoryCaches();
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serviceWorker: {
        async register(url, opts) { calls.registered.push([url, opts]); return { scope: '/' }; },
        async getRegistrations() { return [{ active: { scriptURL: ORIGIN + SW_URL }, async unregister() { calls.unregistered++; } }]; },
      },
    },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, opts) => {
      calls.fetch.push(url);
      if (url === MANIFEST_URL) {
        if (fail) return new Response('nope', { status: 503 });
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const file = FILES.find((f) => url.endsWith(f.url));
      if (!file) return new Response('missing', { status: 404 });
      if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response('b'.repeat(file.size), { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
    configurable: true, writable: true,
  });
  return { calls, caches, restore };
}

test('the preload controller: off by default, downloads in two passes, serves offline state', async (t) => {
  // `import` after the stubs: the module reads globals lazily, but the manifest fetch is kicked off on the first call
  const env = stubEnv();
  t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js');
  const states = [];
  const unsub = mod.subscribeResources((s) => states.push(s));
  t.after(unsub);

  assert.equal(mod.resourceState().phase, 'off');
  assert.equal(mod.resourceState().enabled, false);

  // nothing happens while the player has not turned it on (the settings store reports `preload: false` on every change)
  await mod.syncResources(false);
  assert.equal(env.calls.fetch.length, 0, 'no manifest request while the preload is off');
  assert.equal(env.calls.registered.length, 0);

  // turning it on: manifest, worker, essential tier first, then the rest
  await mod.syncResources(true);
  const st = mod.resourceState();
  assert.equal(env.calls.registered.length, 1);
  assert.deepEqual(env.calls.registered[0], [SW_URL, { type: 'module', scope: '/', updateViaCache: 'none' }]);
  assert.equal(env.calls.fetch[0], MANIFEST_URL);
  assert.deepEqual(env.calls.fetch.slice(1), [
    `${ORIGIN}/assets/audio/bgm.mp3`, `${ORIGIN}/assets/ui/panel.png`, // essential tier, alphabetical
    `${ORIGIN}/assets/char/portrait.png`, `${ORIGIN}/assets/spine/op/x/front/x.skel`, // then the rest
  ]);
  assert.equal(st.phase, 'ready');
  assert.equal(st.complete, true);
  assert.deepEqual([st.done, st.total, st.bytes, st.totalBytes], [4, 4, 22, 22]);
  assert.deepEqual([st.tier1Done, st.tier1Total, st.tier2Done, st.tier2Total], [2, 2, 2, 2]);
  assert.match(st.message, /资源已全部预载完成/, 'the copy never promises offline play');
  assert.equal(/离线/.test(JSON.stringify(states)), false, 'no state text says 离线');
  assert.equal(st.error, false);
  assert.ok(states.some((s) => s.phase === 'download'), 'progress states were published');
  // the panel renders numeric counters: an undefined one used to show as "undefined/3966" mid-download
  for (const s of states) {
    for (const k of ['done', 'total', 'wanted', 'bytes', 'skipped', 'sized', 'sizedTotal', 'tier1Done', 'tier1Total', 'tier2Done', 'tier2Total']) {
      assert.equal(typeof s[k], 'number', `state.${k} while ${s.phase} (${JSON.stringify(s[k])})`);
    }
  }
  assert.ok(states.some((s) => s.phase === 'download' && s.done >= 1 && s.done < 4), 'a mid-download update carried the partial count');
  assert.equal(await (await env.caches.open(cacheName('testversion'))).match(`${ORIGIN}/assets/ui/panel.png`) !== undefined, true);

  // a second sync with the same value is a no-op (the settings store fires for volume changes too)
  const fetches = env.calls.fetch.length;
  await mod.syncResources(true);
  assert.equal(env.calls.fetch.length, fetches, 'no second download');

  // pausing, continuing and clearing
  await mod.syncResources(false);
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(mod.resourceState().phase, 'ready', 'what is cached stays usable');
  await mod.clearResources();
  assert.deepEqual(await env.caches.keys(), [], 'every cache of this app is gone');
  assert.equal(mod.resourceState().phase, 'off');
  assert.equal(mod.resourceState().done, 0);
  assert.equal(env.calls.unregistered, 1, 'nothing left to serve ⇒ the worker is removed');
});

test('the worker entry (public/resource-sw.js) intercepts resources only', async (t) => {
  const saved = ['self', 'caches'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const handlers = {};
  const caches = new MemoryCaches();
  const asset = `${ORIGIN}/assets/e2e/a.png`;
  await (await caches.open(cacheName('sw'))).put(asset, new Response('cached-bytes'));
  Object.defineProperty(globalThis, 'self', { value: { addEventListener: (name, fn) => { handlers[name] = fn; } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  t.after(() => { for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  await import('../../public/resource-sw.js');
  assert.deepEqual(Object.keys(handlers).sort(), ['activate', 'fetch', 'install'], 'the worker registers its listeners');

  const answered = [];
  const fire = (url, method = 'GET') => {
    let promise = null;
    handlers.fetch({ request: new Request(url, { method }), respondWith: (p) => { promise = p; answered.push(url); } });
    return promise;
  };
  assert.equal(await fire(asset).then((r) => r.text()), 'cached-bytes', 'a cached resource is answered');
  assert.equal(fire(`${ORIGIN}/js/main.js`), null, 'code passes through');
  assert.equal(fire(`${ORIGIN}/data/assets.json`), null, 'game data passes through');
  assert.equal(fire(`${ORIGIN}/assets/e2e/a.png`, 'POST'), null, 'only GET');
  assert.deepEqual(answered, [asset]);
});

test('a browser without Cache Storage is reported instead of downloading', async (t) => {
  const env = stubEnv({ secure: false });
  t.after(env.restore);
  // a separate module instance (the controller keeps a session-wide manifest/worker state, as in the browser)
  const mod = await import('../../public/js/resources/index.js?insecure-context');
  await mod.syncResources(true);
  const st = mod.resourceState();
  assert.equal(st.enabled, true, 'the switch stays where the player put it');
  assert.equal(st.supported, false);
  assert.equal(st.phase, 'error');
  assert.match(st.message, /HTTPS|Cache Storage|Service Worker/);
  assert.deepEqual(env.calls.fetch, [], 'nothing is downloaded');
  await mod.syncResources(false);
});
