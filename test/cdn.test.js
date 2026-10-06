// test/cdn.test.js — the assets CDN (SP_ASSETS_CDN, docs/ASSETS.md「CDN」): the server rewrites the /assets/… URLs of
// the manifests it serves (/data/assets.json, /data/local-assets.json), so every client — the asset store, the audio
// loader, the local-client art — asks the CDN for art without knowing that a CDN exists. SP_DATA_CDN independently
// supplies direct browser URLs for static game JSON; origin data remains readable without redirects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createStaticHandler, parseAssetCdn, rewriteAssetPaths, startServer } from '../server/index.js';
import { dataUrl } from '../shared/cdn.js';
import { createDataStore } from '../public/js/data.js';
import { createAssets } from '../public/js/assets.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny stand-in of data/assets.json with the shapes the client reads (docs/ASSETS.md). */
function manifest() {
  return {
    version: 1,
    hash: 'deadbeef',
    chars: { char_002_amiya: { avatar: '/assets/char/avatar/char_002_amiya.png', spine: { front: { skel: '/assets/spine/op/char_002_amiya/front/char_002_amiya.skel', textures: ['/assets/spine/op/char_002_amiya/front/char_002_amiya.png'] } } } },
    ui: { 'battle/sprite_shadow': '/assets/ui/battle/sprite_shadow.png' },
    audio: { bgm: { main: '/assets/audio/bgm/main.mp3' } },
    absolute: 'https://example.com/elsewhere.png',
    relative: 'assets/not-mine.png',
    numbers: [1, '/assets/x.png'],
  };
}

function writeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-'));
  fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify(manifest()));
  fs.writeFileSync(path.join(dir, 'local-assets.json'), JSON.stringify({ version: 1, groups: { module: { 'mar-x': { path: '/assets/local/module/mar-x.png' } } } }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ note: '/assets/not-a-manifest.json' }));
  fs.writeFileSync(path.join(dir, 'asset-hashes.json'), JSON.stringify({ files: { '/assets/x.png': 'abcd1234' } }));
  return dir;
}

function serve(dataDir, cdnBase, dataCdnBase = '') {
  const handler = createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir, sharedDir: path.join(ROOT, 'shared'), cdnBase, dataCdnBase });
  const srv = http.createServer((req, res) => {
    const [p, q] = (req.url || '/').split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function get(srv, url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('parseAssetCdn accepts an absolute URL or a path prefix and drops trailing slashes', () => {
  assert.equal(parseAssetCdn(undefined), '');
  assert.equal(parseAssetCdn(''), '');
  assert.equal(parseAssetCdn('   '), '');
  assert.equal(parseAssetCdn('cdn.example.com/x'), '', 'a bare host is not a directory');
  assert.equal(parseAssetCdn('https://cdn.example.com/stronghold/'), 'https://cdn.example.com/stronghold');
  assert.equal(parseAssetCdn('https://cdn.example.com/'), 'https://cdn.example.com');
  assert.equal(parseAssetCdn('/cdn///'), '/cdn');
  assert.equal(parseAssetCdn('http://127.0.0.1:8080/assets'), 'http://127.0.0.1:8080/assets');
});

test('origin serves GET/HEAD JSON with validators even when a data CDN is configured', async () => {
  const dir = writeDataDir();
  const srv = await serve(dir, 'https://art.example.com/sp', 'https://data.example.com/v1');
  try {
    for (const method of ['GET', 'HEAD']) {
      const r = await get(srv, '/data/config.json?v=123&x=a%20b', {}, method);
      assert.equal(r.status, 200);
      assert.equal(r.headers.location, undefined);
      assert.match(r.headers['cache-control'], /immutable/);
      assert.ok(r.headers.etag);
      if (method === 'HEAD') assert.equal(r.body, '');
      else assert.deepEqual(JSON.parse(r.body), { note: '/assets/not-a-manifest.json' });
      assert.equal((await get(srv, '/data/config.json', { 'If-None-Match': r.headers.etag }, method)).status, 304);
    }
    for (const file of ['assets.json', 'asset-hashes.json']) for (const method of ['GET', 'HEAD']) {
      const r = await get(srv, `/data/${file}?v=123`, {}, method);
      assert.equal(r.status, 200);
      assert.equal(r.headers.location, undefined);
      assert.ok(r.headers.etag);
      if (method === 'HEAD') assert.equal(r.body, '');
      else if (file === 'assets.json') assert.equal(JSON.parse(r.body).chars.char_002_amiya.avatar,
        'https://art.example.com/sp/assets/char/avatar/char_002_amiya.png');
      else assert.deepEqual(JSON.parse(r.body), { files: { '/assets/x.png': 'abcd1234' } });
    }
    const local = await get(srv, '/data/local-assets.json');
    assert.equal(local.status, 200);
    assert.equal(JSON.parse(local.body).groups.module['mar-x'].path, 'https://art.example.com/sp/assets/local/module/mar-x.png');
    for (const url of ['/data/resource-manifest.json', '/data.js', '/shared/constants.js', '/sim/spec.js', '/js/data.js', '/']) {
      const r = await get(srv, url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers.location, undefined, url);
    }
    for (const url of ['/data/no-such-file.json', '/data/config.json/', '/data/.hidden.json', '/data/%2e%2e/config.json']) {
      const r = await get(srv, url);
      assert.ok(r.status === 403 || r.status === 404, `${url}: ${r.status}`);
      assert.equal(r.headers.location, undefined, url);
    }
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('data CDN works independently, supports a same-origin prefix, and preserves missing local art fallback', async () => {
  const dir = writeDataDir();
  fs.unlinkSync(path.join(dir, 'local-assets.json'));
  const srv = await serve(dir, '', '/cdn');
  try {
    const config = await get(srv, '/data/config.json');
    assert.equal(config.status, 200);
    assert.equal(config.headers.location, undefined);
    assert.deepEqual(JSON.parse(config.body), { note: '/assets/not-a-manifest.json' });
    const art = await get(srv, '/data/assets.json');
    assert.equal(art.status, 200);
    assert.equal(art.headers.location, undefined);
    assert.deepEqual(JSON.parse(art.body), manifest());
    const runtime = await import('data:text/javascript,' + encodeURIComponent((await get(srv, '/js/asset-cdn.js')).body));
    assert.equal(runtime.DATA_CDN, '/cdn');
    const local = await get(srv, '/data/local-assets.json');
    assert.equal(local.status, 200);
    assert.deepEqual(JSON.parse(local.body), { version: 1, source: 'none', count: 0, groups: {} });
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('data CDN pointing back to the same Node handler serves JSON without a redirect loop', async () => {
  const dir = writeDataDir();
  const srv = await serve(dir, '', 'https://data.example.com');
  try {
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const r = await fetch(origin + '/data/config.json');
    assert.equal(r.status, 200);
    assert.equal(r.redirected, false);
    assert.equal(r.url, origin + '/data/config.json');
    assert.deepEqual(await r.json(), { note: '/assets/not-a-manifest.json' });
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser loaders read original assets from the data CDN and rewrite with the runtime base', async () => {
  const dir = writeDataDir();
  const source = fs.readFileSync(path.join(dir, 'assets.json'), 'utf8');
  let cdn, srv;
  try {
    cdn = await serve(dir, '');
    const base = `http://127.0.0.1:${cdn.address().port}`;
    srv = await serve(dir, 'https://art.example.com/sp', base);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const runtime = await fetch(origin + '/js/asset-cdn.js');
    assert.equal(runtime.headers.get('cache-control'), 'no-cache');
    const runtimeText = await runtime.text();
    const { ASSETS_CDN: assetsCdn, DATA_CDN: dataCdn } = await import('data:text/javascript,' + encodeURIComponent(runtimeText));
    assert.equal(assetsCdn, 'https://art.example.com/sp');
    assert.equal(dataCdn, base);
    const unchanged = await get(srv, '/js/asset-cdn.js', { 'If-None-Match': runtime.headers.get('etag') });
    assert.equal(unchanged.status, 304);
    assert.equal((await get(srv, '/js/asset-cdn.js', {}, 'HEAD')).body, '');
    const assets = await fetch(`${base}/data/assets.json`);
    assert.equal(assets.redirected, false);
    assert.equal(assets.url, `${base}/data/assets.json`);
    const doc = await assets.json();
    assert.deepEqual(doc, manifest(), 'CDN JSON is uploaded unchanged');
    const requests = [];
    const fetchFn = async (url, opts) => {
      requests.push(url);
      const response = await fetch(new URL(url, origin), opts);
      assert.equal(response.redirected, false, 'browser loaders request the final destination directly');
      return response;
    };
    const data = createDataStore({ fetch: fetchFn, assetsCdn, dataCdn });
    const rewritten = await data.load('assets');
    assert.equal(rewritten.chars.char_002_amiya.avatar, 'https://art.example.com/sp/assets/char/avatar/char_002_amiya.png');
    assert.equal(rewritten.audio.bgm.main, 'https://art.example.com/sp/assets/audio/bgm/main.mp3');
    assert.equal(rewritten.absolute, manifest().absolute, 'absolute URLs are not rewritten again');
    const store = createAssets({ fetch: fetchFn, assetsCdn, dataCdn });
    assert.deepEqual(await store.ready(), rewritten, 'standalone art loader applies the same rewrite');
    const local = await data.load('local');
    assert.equal(local.groups.module['mar-x'].path, 'https://art.example.com/sp/assets/local/module/mar-x.png');
    assert.deepEqual(await store.local(), local, 'already rewritten server manifests are not double-prefixed');
    assert.deepEqual(await data.load('config'), { note: '/assets/not-a-manifest.json' }, 'other data is untouched');
    assert.deepEqual(await data.load('asset-hashes'), { files: { '/assets/x.png': 'abcd1234' } });
    assert.deepEqual(requests, [`${base}/data/assets.json`, `${base}/data/assets.json`,
      '/data/local-assets.json', '/data/local-assets.json', `${base}/data/config.json`, `${base}/data/asset-hashes.json`]);
    assert.equal(doc.hash, 'deadbeef');
    const hashes = await fetch(`http://127.0.0.1:${srv.address().port}/data/asset-hashes.json`);
    assert.equal(hashes.redirected, false);
    assert.deepEqual(await hashes.json(), { files: { '/assets/x.png': 'abcd1234' } });
    const preload = JSON.parse((await get(srv, '/data/resource-manifest.json')).body);
    assert.ok(preload.files.some((f) => f.url === 'https://art.example.com/sp/assets/x.png' && f.hash === 'abcd1234'));
    assert.equal((await get(srv, '/data/local-assets.json')).status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'), source);
    const noArtCdn = createDataStore({ fetch: fetchFn, assetsCdn: '', dataCdn });
    assert.deepEqual(await noArtCdn.load('assets'), manifest(), 'data CDN alone retains game-origin asset URLs');
  } finally {
    srv?.close();
    cdn?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct data URLs preserve origin-only manifests, query strings, and explicit loader overrides', async () => {
  for (const base of ['https://cdn.example.com/sp/', '/cdn/']) {
    const normalized = base.replace(/\/+$/, '');
    assert.equal(dataUrl('/data/chess.json?v=1', base), `${normalized}/data/chess.json?v=1`);
    assert.equal(dataUrl('/data/assets.json', base), `${normalized}/data/assets.json`);
    for (const url of ['/data/local-assets.json', '/data/resource-manifest.json', '/api/ping',
      '/data/nested/x.json', 'https://other.example.com/data/chess.json']) assert.equal(dataUrl(url, base), url);
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
    const data = createDataStore({ fetch: fetchFn, dataCdn: base });
    await data.load('chess');
    await data.load('local');
    await data.load('resource-manifest');
    assert.deepEqual(calls, [`${normalized}/data/chess.json`, '/data/local-assets.json', '/data/resource-manifest.json']);
    calls.length = 0;
    await createDataStore({ fetch: fetchFn, base: '/custom/', dataCdn: base }).load('chess');
    await createAssets({ fetch: fetchFn, url: '/custom/assets.json', dataCdn: base }).ready();
    assert.deepEqual(calls, ['/custom/chess.json', '/custom/assets.json']);
  }
  assert.equal(dataUrl('/data/chess.json', ''), '/data/chess.json');
});

test('changing only the data CDN changes the runtime config validator; disk fallback exports empty bases', async () => {
  const dir = writeDataDir();
  const a = await serve(dir, '', 'https://data.example.com/v1');
  const b = await serve(dir, '', 'https://data.example.com/v2');
  try {
    const first = await get(a, '/js/asset-cdn.js');
    const second = await get(b, '/js/asset-cdn.js', { 'If-None-Match': first.headers.etag });
    assert.equal(second.status, 200);
    assert.notEqual(second.headers.etag, first.headers.etag);
    const config = await import('data:text/javascript,' + encodeURIComponent(second.body));
    assert.equal(config.ASSETS_CDN, '');
    assert.equal(config.DATA_CDN, 'https://data.example.com/v2');
    const fallback = await import('../public/js/asset-cdn.js');
    assert.equal(fallback.DATA_CDN, '');
    assert.equal(fallback.ASSETS_CDN, '');
  } finally {
    a.close(); b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer reads SP_DATA_CDN, reports it and allows an explicit option to disable it', async () => {
  const dir = writeDataDir();
  const prev = process.env.SP_DATA_CDN;
  process.env.SP_DATA_CDN = 'https://data.example.com/v1/';
  const opts = { port: 0, quiet: true, dataDir: dir, store: null, log: { info() {}, warn() {}, error() {}, debug() {} } };
  let srv;
  try {
    srv = await startServer(opts);
    let fake = { address: () => ({ port: srv.port }) };
    assert.equal(JSON.parse((await get(fake, '/metrics')).body).dataCdn, 'https://data.example.com/v1');
    const localData = await get(fake, '/data/config.json');
    assert.equal(localData.status, 200);
    assert.equal(localData.headers.location, undefined);
    assert.deepEqual(JSON.parse(localData.body), { note: '/assets/not-a-manifest.json' });
    await srv.close();
    srv = null;
    srv = await startServer({ ...opts, dataCdn: '' });
    fake = { address: () => ({ port: srv.port }) };
    assert.equal(JSON.parse((await get(fake, '/metrics')).body).dataCdn, null);
    const r = await get(fake, '/data/config.json');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { note: '/assets/not-a-manifest.json' });
  } finally {
    if (srv) await srv.close();
    if (prev == null) delete process.env.SP_DATA_CDN; else process.env.SP_DATA_CDN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rewriteAssetPaths only touches /assets/… strings, at any depth', () => {
  const doc = manifest();
  const out = rewriteAssetPaths(doc, 'https://cdn.example.com/sp');
  assert.equal(out.chars.char_002_amiya.avatar, 'https://cdn.example.com/sp/assets/char/avatar/char_002_amiya.png');
  assert.deepEqual(out.chars.char_002_amiya.spine.front.textures, ['https://cdn.example.com/sp/assets/spine/op/char_002_amiya/front/char_002_amiya.png']);
  assert.equal(out.ui['battle/sprite_shadow'], 'https://cdn.example.com/sp/assets/ui/battle/sprite_shadow.png');
  assert.equal(out.audio.bgm.main, 'https://cdn.example.com/sp/assets/audio/bgm/main.mp3');
  assert.equal(out.numbers[1], 'https://cdn.example.com/sp/assets/x.png');
  assert.equal(out.hash, 'deadbeef', 'non-URL strings stay');
  assert.equal(out.absolute, 'https://example.com/elsewhere.png', 'another origin stays');
  assert.equal(out.relative, 'assets/not-mine.png', 'relative paths stay');
  // and it is a no-op without a base
  assert.deepEqual(rewriteAssetPaths(manifest(), ''), manifest());
});

test('the served manifests point at the CDN, other data files do not', async () => {
  const dir = writeDataDir();
  const srv = await serve(dir, 'https://cdn.example.com/sp');
  try {
    const assets = await get(srv, '/data/assets.json');
    assert.equal(assets.status, 200);
    const doc = JSON.parse(assets.body);
    assert.equal(doc.chars.char_002_amiya.avatar, 'https://cdn.example.com/sp/assets/char/avatar/char_002_amiya.png');
    assert.equal(doc.ui['battle/sprite_shadow'], 'https://cdn.example.com/sp/assets/ui/battle/sprite_shadow.png');
    assert.equal(doc.numbers[1], 'https://cdn.example.com/sp/assets/x.png');
    const local = JSON.parse((await get(srv, '/data/local-assets.json')).body);
    assert.equal(local.groups.module['mar-x'].path, 'https://cdn.example.com/sp/assets/local/module/mar-x.png');
    const config = JSON.parse((await get(srv, '/data/config.json')).body);
    assert.equal(config.note, '/assets/not-a-manifest.json', 'only the two manifests are rewritten');
    // validators still work on the rewritten body
    const again = await get(srv, '/data/assets.json', { 'If-None-Match': assets.headers.etag });
    assert.equal(again.status, 304);
    const head = await get(srv, '/data/assets.json');
    assert.equal(head.status, 200);
    void head;
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a CDN the manifests are served byte for byte', async () => {
  const dir = writeDataDir();
  const srv = await serve(dir, '');
  try {
    const r = await get(srv, '/data/assets.json');
    assert.deepEqual(JSON.parse(r.body), manifest());
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a same-origin CDN prefix works too', async () => {
  const dir = writeDataDir();
  const srv = await serve(dir, '/cdn');
  try {
    const doc = JSON.parse((await get(srv, '/data/assets.json')).body);
    assert.equal(doc.chars.char_002_amiya.avatar, '/cdn/assets/char/avatar/char_002_amiya.png');
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer picks up SP_ASSETS_CDN and reports it on /metrics', async () => {
  const dir = writeDataDir();
  const prev = process.env.SP_ASSETS_CDN;
  process.env.SP_ASSETS_CDN = 'https://cdn.example.com/stronghold/';
  const srv = await startServer({ port: 0, quiet: true, dataDir: dir, store: null, log: { info() {}, warn() {}, error() {}, debug() {} } });
  const fake = { address: () => ({ port: srv.port }) };
  try {
    const health = JSON.parse((await get(fake, '/metrics')).body);
    assert.equal(health.assetsCdn, 'https://cdn.example.com/stronghold', 'trailing slash dropped');
    assert.equal(health.persist ?? null, null, 'no Redis configured in this test');
    const doc = JSON.parse((await get(fake, '/data/assets.json')).body);
    assert.equal(doc.chars.char_002_amiya.avatar, 'https://cdn.example.com/stronghold/assets/char/avatar/char_002_amiya.png');
  } finally {
    await srv.close();
    if (prev == null) delete process.env.SP_ASSETS_CDN; else process.env.SP_ASSETS_CDN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
