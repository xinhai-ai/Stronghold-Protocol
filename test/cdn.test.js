// test/cdn.test.js — the assets CDN (SP_ASSETS_CDN, docs/ASSETS.md「CDN」): the server rewrites the /assets/… URLs of
// the manifests it serves (/data/assets.json, /data/local-assets.json), so every client — the asset store, the audio
// loader, the local-client art — asks the CDN for art without knowing that a CDN exists. Everything else is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createStaticHandler, parseAssetCdn, rewriteAssetPaths, startServer } from '../server/index.js';

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
  return dir;
}

function serve(dataDir, cdnBase) {
  const handler = createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir, sharedDir: path.join(ROOT, 'shared'), cdnBase });
  const srv = http.createServer((req, res) => {
    const [p, q] = (req.url || '/').split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function get(srv, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, headers }, (res) => {
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

test('startServer picks up SP_ASSETS_CDN and reports it on /healthz', async () => {
  const dir = writeDataDir();
  const prev = process.env.SP_ASSETS_CDN;
  process.env.SP_ASSETS_CDN = 'https://cdn.example.com/stronghold/';
  const srv = await startServer({ port: 0, quiet: true, dataDir: dir, store: null, log: { info() {}, warn() {}, error() {}, debug() {} } });
  const fake = { address: () => ({ port: srv.port }) };
  try {
    const health = JSON.parse((await get(fake, '/healthz')).body);
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
