// test/resources/browser.e2e.test.js — the optional offline-resource preload in headless Chrome: a Service Worker is
// registered, the files land in Cache Storage and a resource request is answered with the network off
// (docs/ASSETS.md「Preload」).
//
// Opt-in (starts Chrome): RESOURCE_E2E=1 node --test test/resources/browser.e2e.test.js
// Chrome path: $CHROME_PATH or the macOS default. The fixture install (its own public/ + data/) lives in a temp dir, so
// the test never touches public/assets.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.RESOURCE_E2E === '1' && fs.existsSync(CHROME);
const skip = enabled ? false : 'set RESOURCE_E2E=1 (needs Chrome)';

const FILES = [
  { url: '/assets/e2e/panel.png', tier: 1, body: 'panel-bytes' },
  { url: '/assets/e2e/bgm.mp3', tier: 1, body: 'bgm-bytes-1234' },
  { url: '/assets/e2e/deep/portrait.png', tier: 2, body: 'portrait' },
];

/** A minimal install: the client modules, the worker and a fixture asset tree. */
function makeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-res-'));
  const publicDir = path.join(dir, 'public');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(publicDir, 'js'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'public', 'resource-sw.js'), path.join(publicDir, 'resource-sw.js'));
  for (const f of FILES) {
    const abs = path.join(publicDir, f.url);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
  }
  fs.writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify({
    version: 1,
    hash: 'e2e0000',
    ui: { 'e2e/panel': FILES[0].url },
    audio: { bgm: { e2e: { loop: FILES[1].url } } },
    chars: { char_e2e: { portrait: FILES[2].url } },
  }));
  fs.writeFileSync(path.join(publicDir, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>resource e2e</title></head><body><div id="app"></div>
<script type="module">
  const mod = await import('/js/resources/index.js');
  window.__res = mod;
  window.__preload = (on) => mod.syncResources(on);
  window.__ready = true;
</script></body></html>`);
  return { dir, publicDir, dataDir };
}

describe('offline resources in headless Chrome', { skip }, () => {
  let srv;
  let browser;
  let install;

  before(async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const { startServer } = await import('../../server/index.js');
    install = makeInstall();
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, publicDir: install.publicDir, dataDir: install.dataDir, store: null,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
    if (install) fs.rmSync(install.dir, { recursive: true, force: true });
  });

  test('the settings switch downloads the files and the worker serves them with the network off', async () => {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    // a resource load failure is expected here: the fixture has no favicon, and the test fetches an uncached file offline
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`);
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });

    // the server offers the list, with the sizes of the files this install has
    const manifest = await page.evaluate(() => fetch('/data/resource-manifest.json').then((r) => r.json()));
    assert.equal(manifest.count, 3);
    assert.deepEqual(manifest.files.map((f) => f.tier), [1, 1, 2]);
    assert.deepEqual(manifest.files.map((f) => f.size), [14, 11, 8], 'essential tier first, then by URL');

    // off by default: nothing is fetched before the player asks for it
    assert.equal(await page.evaluate(() => window.__res.resourceState().phase), 'off');

    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.resourceState().complete === true', { timeout: 30000 });
    const st = await page.evaluate(() => window.__res.resourceState());
    assert.equal(st.phase, 'ready');
    assert.deepEqual([st.done, st.total, st.bytes], [3, 3, 33]);
    assert.equal(st.worker, '', 'the Service Worker registered');

    // it controls this page (public/resource-sw.js claims its clients) and answers from Cache Storage
    await page.waitForFunction('!!navigator.serviceWorker.controller', { timeout: 20000 });
    const cached = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find((n) => n.startsWith('stronghold-resources-v1-')));
      const keys = await cache.keys();
      return keys.map((k) => new URL(k.url).pathname).sort();
    });
    assert.deepEqual(cached, FILES.map((f) => f.url).sort());

    // with the network off the cache still answers — and only for the resources (code is never cached)
    await page.setOfflineMode(true);
    const offline = await page.evaluate(async () => ({
      asset: await fetch('/assets/e2e/bgm.mp3').then((r) => r.text()),
      range: await fetch('/assets/e2e/panel.png', { headers: { Range: 'bytes=0-4' } }).then(async (r) => ({ status: r.status, text: await r.text() })),
      other: await fetch('/js/resources/common.js').then(() => 'served', (err) => `failed: ${err.name}`),
    }));
    assert.equal(offline.asset, 'bgm-bytes-1234', 'a cached resource is served offline');
    assert.deepEqual(offline.range, { status: 206, text: 'panel' }, 'ranges work from the cache');
    assert.match(offline.other, /failed/, 'anything uncached still needs the network (the worker never caches code)');
    await page.setOfflineMode(false);

    // turning the switch off and clearing removes every trace
    await page.evaluate(() => window.__preload(false));
    await page.evaluate(() => window.__res.clearResources());
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('a second visit finds the files already cached (a new manifest version starts over)', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`);
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    await page.evaluate(() => window.__preload(true));
    await page.waitForFunction('window.__res.resourceState().complete === true', { timeout: 30000 });
    const state = await page.evaluate(() => window.__res.resourceState());
    assert.equal(state.complete, true);
    assert.equal(state.done, 3);
    // the cache name carries the asset manifest hash: a new build downloads again instead of serving old art
    assert.equal(state.version, 'e2e0000');
    await page.close();
  });
});
