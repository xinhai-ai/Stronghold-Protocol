// test/resources/manifest.test.js — /data/resource-manifest.json (server/resources.js, docs/ASSETS.md「Preload」): the
// file list the client may preload, its two tiers, the sizes of the files this install has, the CDN rewrite and the
// HTTP shape (no-cache + ETag/304 + gzip + HEAD).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createStaticHandler, rewriteAssetPaths } from '../../server/index.js';
import {
  RESOURCE_MANIFEST_FILE, RESOURCES_FORMAT, TIER_ESSENTIAL, TIER_REST, buildResourceManifest, collectResourceFiles,
  createResourceIndex, isResourcePath, localPathFor, resourceType, tierForPath, validateResourceUrl,
} from '../../server/resources.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The shapes of data/assets.json the preload reads (docs/ASSETS.md). */
function manifest(over = {}) {
  return {
    version: 1,
    hash: 'deadbeefcafe',
    stats: { files: 12, bytes: 999 },
    chars: {
      char_002_amiya: {
        avatar: '/assets/char/avatar/char_002_amiya.png',
        avatarE2: '/assets/char/avatar/char_002_amiya_2.png',
        portrait: '/assets/char/portrait/char_002_amiya_1.png',
        spine: { front: { skel: '/assets/spine/op/char_002_amiya/front/char_002_amiya.skel', atlas: '/assets/spine/op/char_002_amiya/front/char_002_amiya.atlas', textures: ['/assets/spine/op/char_002_amiya/front/char_002_amiya.png'] } },
      },
    },
    enemies: { enemy_1007_slime: { icon: '/assets/enemy/icon/enemy_1007_slime.png', spine: { skel: '/assets/spine/enemy/enemy_1007_slime/enemy_1007_slime.skel' } }, enemy_alias: { spineAliasOf: 'enemy_1007_slime' } },
    tokens: { token_a: { owner: 'char_002_amiya', avatar: '/assets/token/avatar/token_a.png' } },
    ui: { 'battle/sprite_shadow': '/assets/ui/battle/sprite_shadow.png' },
    bonds: { yanShip: '/assets/bond/yan.png' },
    items: { trap_1: '/assets/item/1041.png' },
    bands: { band_bldsk: '/assets/band/bldsk.png' },
    skills: { skchr_x: '/assets/skill/x.png' },
    skillsById: { skill_y: 'skchr_x' },
    prof: { icon: { sniper: '/assets/prof/sniper.png' }, sub: { fastshot: '/assets/prof/sub/fastshot.png' } },
    audio: { bgm: { lobby: { intro: '/assets/audio/bgm/lobby_intro.mp3', loop: '/assets/audio/bgm/lobby_loop.mp3' } }, sfx: { battle: { deploy: '/assets/audio/sfx/deploy.mp3' }, units: { char_002_amiya: { attack: '/assets/audio/sfx/amiya_atk.mp3', skills: { 2: '/assets/audio/sfx/amiya_s3.mp3' } } } } },
    fonts: { css: '/fonts/fonts.css', faces: { bender: { family: 'Bender', weight: 400, woff2: '/fonts/bender-regular.woff2', original: '/fonts/bender-regular.otf' } } },
    notAFile: 'char_002_amiya',
    elsewhere: 'https://example.com/elsewhere.png',
    relative: 'assets/not-mine.png',
    ...over,
  };
}

const local = () => ({
  version: 1,
  groups: {
    map: { TX_autochessi_D: { path: '/assets/local/map/autochess/TX_D.png', hash: 'aaaabbbbcccc' } },
    emoticon: { e1: { path: '/assets/local/emoticon/e1.png' } },
  },
});

/** A temp install: the two manifests (plus optional asset hashes) and the files that actually exist on disk. */
function install({ assets = manifest(), localDoc = local(), hashesDoc = null, files = [
  'assets/char/avatar/char_002_amiya.png', 'assets/ui/battle/sprite_shadow.png', 'assets/audio/bgm/lobby_loop.mp3',
  'assets/spine/op/char_002_amiya/front/char_002_amiya.skel', 'assets/local/map/autochess/TX_D.png', 'fonts/bender-regular.woff2',
] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-res-data-'));
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-res-pub-'));
  if (assets) fs.writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify(assets));
  if (localDoc) fs.writeFileSync(path.join(dataDir, 'local-assets.json'), JSON.stringify(localDoc));
  if (hashesDoc) fs.writeFileSync(path.join(dataDir, 'asset-hashes.json'), JSON.stringify(hashesDoc));
  for (const rel of files) {
    const abs = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(rel.length, 1));
  }
  return { dataDir, publicDir, cleanup: () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(publicDir, { recursive: true, force: true }); } };
}

function serve(inst, cdnBase = '') {
  const handler = createStaticHandler({
    publicDir: inst.publicDir, dataDir: inst.dataDir, sharedDir: path.join(ROOT, 'shared'), cdnBase,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const srv = http.createServer((req, res) => {
    const [p, q] = (req.url || '/').split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

describe('resource manifest building', () => {
  test('URL rules mirror the client (only asset trees, no query/fragment/protocol-relative)', () => {
    assert.equal(validateResourceUrl('/assets/x.png'), true);
    assert.equal(validateResourceUrl('/fonts/x.woff2'), true);
    assert.equal(validateResourceUrl('https://cdn.example.com/assets/spine/x/front/x.skel'), true);
    for (const bad of ['', '/data/assets.json', 'assets/x.png', '//cdn.example.com/assets/x.png', '/assets/x.png?v=1',
      '/assets/x.png#a', '/assets/x', '/assets/x.txt', 'javascript:alert(1).png', '/assets/a b.png', null, 42]) {
      assert.equal(validateResourceUrl(bad), false, String(bad));
    }
    assert.equal(isResourcePath('/assets/x.png'), true);
    assert.equal(isResourcePath('/data/x.json'), false);
    assert.equal(resourceType('/assets/x.atlas'), 'text/plain; charset=utf-8');
    assert.equal(localPathFor('/assets/x.png', '/srv/public'), path.join(path.resolve('/srv/public'), 'assets/x.png'));
    assert.equal(localPathFor('https://cdn.example.com/base/assets/x.png', '/srv/public', 'https://cdn.example.com/base'), path.join(path.resolve('/srv/public'), 'assets/x.png'));
    assert.equal(localPathFor('https://cdn.example.com/base/assets/x.png', '/srv/public'), null, 'outside the CDN prefix');
    assert.equal(localPathFor('/assets/../../etc/passwd', '/srv/public'), null, 'no traversal');
    assert.equal(localPathFor('/data/x.json', '/srv/public'), path.join(path.resolve('/srv/public'), 'data/x.json'), 'only the URL shape is refused here');
  });

  test('tiers: avatars/icons/audio/fonts/UI are essential, portraits and Spine models are background', () => {
    assert.equal(tierForPath('fonts.faces.bender.woff2'), TIER_ESSENTIAL);
    assert.equal(tierForPath('ui.battle/sprite_shadow'), TIER_ESSENTIAL);
    assert.equal(tierForPath('audio.sfx.units.char_002_amiya.skills.2'), TIER_ESSENTIAL);
    assert.equal(tierForPath('chars.char_002_amiya.avatar'), TIER_ESSENTIAL);
    assert.equal(tierForPath('enemies.enemy_1007_slime.icon'), TIER_ESSENTIAL);
    assert.equal(tierForPath('chars.char_002_amiya.portrait'), TIER_REST);
    assert.equal(tierForPath('chars.char_002_amiya.spine.front.skel'), TIER_REST);
    assert.equal(tierForPath('tokens.token_a.spine.skel'), TIER_REST);
    assert.equal(tierForPath('local.groups.map.TX_autochessi_D.path'), TIER_ESSENTIAL);
    assert.equal(tierForPath('local.groups.emoticon.e1.path'), TIER_REST);
    assert.equal(tierForPath('somethingNew.a/b.png'), TIER_REST, 'unknown sections stay out of the fast path');
  });

  test('collect: every resource file, deduplicated, essential first, ids/aliases skipped', () => {
    const files = collectResourceFiles(manifest(), local());
    const urls = files.map((f) => f.url);
    assert.equal(new Set(urls).size, urls.length, 'no duplicates');
    assert.deepEqual([...files].sort((a, b) => a.tier - b.tier), files, 'sorted essential first');
    assert.ok(urls.includes('/assets/char/avatar/char_002_amiya.png'));
    assert.ok(urls.includes('/assets/spine/op/char_002_amiya/front/char_002_amiya.atlas'));
    assert.ok(urls.includes('/assets/local/emoticon/e1.png'));
    assert.ok(urls.includes('/fonts/fonts.css'));
    for (const notAFile of ['char_002_amiya', 'skchr_x', 'skill_y', 'enemy_1007_slime', 'https://example.com/elsewhere.png', 'assets/not-mine.png']) {
      assert.ok(!urls.includes(notAFile), notAFile);
    }
    assert.equal(files.find((f) => f.url === '/assets/char/avatar/char_002_amiya.png').tier, TIER_ESSENTIAL);
    assert.equal(files.find((f) => f.url === '/fonts/bender-regular.otf').tier, TIER_ESSENTIAL);
    assert.equal(files.find((f) => f.url === '/assets/char/portrait/char_002_amiya_1.png').tier, TIER_REST);
    assert.equal(collectResourceFiles(null, null).length, 0);
  });

  test('a shared file keeps its essential tier (the lowest one wins)', () => {
    const assets = manifest({ chars: { c: { avatar: '/assets/shared.png', portrait: '/assets/shared.png' } } });
    const shared = collectResourceFiles(assets, null).filter((f) => f.url === '/assets/shared.png');
    assert.equal(shared.length, 1, 'listed once');
    assert.equal(shared[0].tier, TIER_ESSENTIAL);
  });

  test('build: sizes are optional per file, counters add up', () => {
    const files = [{ url: '/assets/a.png', tier: TIER_ESSENTIAL }, { url: '/assets/b.png', tier: TIER_REST }, { url: '/assets/c.png', tier: TIER_REST }];
    const sizes = new Map([['/assets/a.png', 10], ['/assets/c.png', 5]]);
    const m = buildResourceManifest({ files, sizes, version: 'v1' });
    assert.equal(m.format, RESOURCES_FORMAT);
    assert.equal(m.version, 'v1');
    assert.equal(m.count, 3);
    assert.equal(m.tier1, 1);
    assert.equal(m.sized, 2);
    assert.equal(m.totalBytes, 15);
    assert.deepEqual(m.files[0], { url: '/assets/a.png', tier: 1, size: 10 });
    assert.deepEqual(m.files[1], { url: '/assets/b.png', tier: 2 }, 'an unknown size is simply absent');
    assert.equal(buildResourceManifest({ files, version: 'v' }).totalBytes, null, 'no sizes at all ⇒ count progress instead');
    assert.equal(buildResourceManifest({ files: [], version: 'v' }).count, 0);
  });
});

describe('the served resource manifest', () => {
  test('lists the files, marks the ones on disk with their size and reports the manifest version', async (t) => {
    const inst = install();
    const srv = await serve(inst);
    t.after(() => { srv.close(); inst.cleanup(); });
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/data/${RESOURCE_MANIFEST_FILE}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache', 'the client revalidates: a new build must be seen');
    assert.match(res.headers.get('content-type'), /application\/json/);
    const m = await res.json();
    assert.equal(m.format, RESOURCES_FORMAT);
    assert.match(m.version, /^[0-9a-f]{12}$/, 'the version is a digest of every url|hash');
    assert.ok(m.count > 20);
    assert.ok(m.tier1 > 0 && m.tier1 < m.count);
    const byUrl = new Map(m.files.map((f) => [f.url, f]));
    assert.equal(byUrl.get('/assets/char/avatar/char_002_amiya.png').size, 'assets/char/avatar/char_002_amiya.png'.length);
    assert.equal(byUrl.get('/assets/spine/op/char_002_amiya/front/char_002_amiya.skel').tier, TIER_REST);
    assert.equal(byUrl.has('/assets/char/avatar/char_002_amiya.png') && 'size' in byUrl.get('/assets/spine/enemy/enemy_1007_slime/enemy_1007_slime.skel'), false, 'a file this install does not have carries no size');
    assert.equal(m.sized < m.count, true);
    assert.ok(m.totalBytes > 0);
    assert.deepEqual(m.files.map((f) => f.tier), [...m.files.map((f) => f.tier)].sort((a, b) => a - b), 'essential first');
  });

  test('the CDN rewrites the entries (the client preloads from the CDN without knowing it)', async (t) => {
    const inst = install();
    const srv = await serve(inst, 'https://cdn.example.com/static');
    t.after(() => { srv.close(); inst.cleanup(); });
    const m = await (await fetch(`http://127.0.0.1:${srv.address().port}/data/${RESOURCE_MANIFEST_FILE}`)).json();
    const other = install();
    const srvOther = await serve(other);
    t.after(() => { srvOther.close(); other.cleanup(); });
    const plain = await (await fetch(`http://127.0.0.1:${srvOther.address().port}/data/${RESOURCE_MANIFEST_FILE}`)).json();
    assert.notEqual(m.version, plain.version, 'a different CDN is a different version');
    assert.ok(m.files.every((f) => f.url.startsWith('https://cdn.example.com/static/') || f.url.startsWith('/fonts/')));
    assert.ok(m.files.some((f) => f.url === 'https://cdn.example.com/static/assets/char/avatar/char_002_amiya.png' && f.size === 'assets/char/avatar/char_002_amiya.png'.length), 'a CDN URL still maps back to the local file for its size');
  });

  test('HTTP shape: gzip when accepted, 304 on the ETag, HEAD without a body', async (t) => {
    const inst = install();
    const srv = await serve(inst);
    t.after(() => { srv.close(); inst.cleanup(); });
    const url = `http://127.0.0.1:${srv.address().port}/data/${RESOURCE_MANIFEST_FILE}`;
    const gz = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
    const body = await gz.json();
    assert.ok(body.count > 0);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const notModified = await fetch(url, { headers: { 'if-none-match': head.headers.get('etag') } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), '');
    assert.equal(notModified.headers.get('etag'), head.headers.get('etag'), 'the validator stays the same');
  });

  test('every entry carries a hash: the recorded one when known, a synthetic one otherwise', async (t) => {
    const inst = install({
      hashesDoc: { version: 1, generator: 'tools/asset-hashes.mjs', count: 1, bytes: 10, files: { '/assets/ui/battle/sprite_shadow.png': 'fedcba987654' } },
    });
    const srv = await serve(inst);
    t.after(() => { srv.close(); inst.cleanup(); });
    const m = await (await fetch(`http://127.0.0.1:${srv.address().port}/data/${RESOURCE_MANIFEST_FILE}`)).json();
    const byUrl = new Map(m.files.map((f) => [f.url, f]));
    assert.equal(byUrl.get('/assets/local/map/autochess/TX_D.png').hash, 'aaaabbbbcccc', 'data/local-assets.json gives the local art its hash');
    assert.equal(byUrl.get('/assets/ui/battle/sprite_shadow.png').hash, 'fedcba987654', 'data/asset-hashes.json covers the fetched assets');
    assert.match(byUrl.get('/assets/char/avatar/char_002_amiya.png').hash, /^syn-[0-9a-f]{12}$/, 'a file without a known hash falls back to its source stamp');
    assert.match(byUrl.get('/assets/local/emoticon/e1.png').hash, /^syn-[0-9a-f]{12}$/);
    assert.ok(m.files.every((f) => typeof f.hash === 'string' && f.hash.length > 0), 'the client can always compare something');
    // the fallback keeps the old rule: a regenerated asset manifest invalidates the fetched files it does not hash
    const other = install({ assets: manifest({ hash: 'otherhash000' }), hashesDoc: { version: 1, files: { '/assets/ui/battle/sprite_shadow.png': 'fedcba987654' } } });
    const srv2 = await serve(other);
    t.after(() => { srv2.close(); other.cleanup(); });
    const m2 = await (await fetch(`http://127.0.0.1:${srv2.address().port}/data/${RESOURCE_MANIFEST_FILE}`)).json();
    assert.notEqual(m2.files.find((f) => f.url === '/assets/char/avatar/char_002_amiya.png').hash, byUrl.get('/assets/char/avatar/char_002_amiya.png').hash);
    assert.equal(m2.files.find((f) => f.url === '/assets/ui/battle/sprite_shadow.png').hash, 'fedcba987654', 'a hashed file does not depend on the asset manifest hash any more');
  });

  test('an install without data/assets.json answers an empty manifest (never a 404 loop)', async (t) => {
    const inst = install({ assets: null, localDoc: null });
    const srv = await serve(inst);
    t.after(() => { srv.close(); inst.cleanup(); });
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/data/${RESOURCE_MANIFEST_FILE}`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.deepEqual({ format: m.format, count: m.count, files: m.files }, { format: RESOURCES_FORMAT, count: 0, files: [] });
  });

  test('other /data/ paths are untouched (the manifest name is the only generated one)', async (t) => {
    const inst = install();
    const srv = await serve(inst);
    t.after(() => { srv.close(); inst.cleanup(); });
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/data/assets.json`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).hash, 'deadbeefcafe');
  });
});

describe('the resource index cache', () => {
  test('the version follows the hashes, not the file times', async () => {
    const localDoc = { version: 1, groups: { map: { TX: { path: '/assets/local/map/autochess/TX_D.png', hash: 'aaaaaaaaaaaa' } } } };
    const inst = install({ localDoc });
    try {
      const index = createResourceIndex({ dataDir: inst.dataDir, publicDir: inst.publicDir });
      const a = await index.get();
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(path.join(inst.dataDir, 'local-assets.json'), JSON.stringify(localDoc)); // same art, new mtime
      const b = await index.get();
      assert.equal(b.manifest.version, a.manifest.version, 'a re-extraction that changed nothing is the same version');
      fs.writeFileSync(path.join(inst.dataDir, 'local-assets.json'), JSON.stringify({ version: 1, groups: { map: { TX: { path: '/assets/local/map/autochess/TX_D.png', hash: 'bbbbbbbbbbbb' } } } }));
      const c = await index.get();
      assert.notEqual(c.manifest.version, a.manifest.version, 'changed art is a new version');
      assert.equal(c.manifest.files.find((f) => f.url === '/assets/local/map/autochess/TX_D.png').hash, 'bbbbbbbbbbbb');
    } finally { inst.cleanup(); }
  });
  test('rebuilds only when a source manifest changes', async () => {
    const inst = install();
    const index = createResourceIndex({ dataDir: inst.dataDir, publicDir: inst.publicDir, rewrite: (v) => rewriteAssetPaths(v, 'https://cdn.example.com'), cdnBase: 'https://cdn.example.com' });
    const a = await index.get();
    const b = await index.get();
    assert.equal(a.body, b.body, 'the same buffers while nothing changed');
    assert.ok(a.manifest.files.some((f) => /^https:\/\/cdn\.example\.com\/assets\//.test(f.url)), 'asset entries point at the CDN');
    assert.ok(a.manifest.files.every((f) => f.url.startsWith('https://cdn.example.com/') || f.url.startsWith('/fonts/')));
    fs.writeFileSync(path.join(inst.dataDir, 'assets.json'), JSON.stringify(manifest({ hash: '0123456789ab' })));
    const c = await index.get();
    assert.notEqual(c.body, a.body);
    assert.notEqual(c.manifest.version, a.manifest.version, 'a regenerated asset manifest is a new version');
    assert.match(c.manifest.version, /^[0-9a-f]{12}$/);
    assert.ok(c.gzip.length < c.body.length, 'the served copy is compressed too');
    inst.cleanup();
  });

  test('a missing file simply has no size (a CDN-only install)', async () => {
    const inst = install({ files: [] });
    const index = createResourceIndex({ dataDir: inst.dataDir, publicDir: inst.publicDir });
    const m = (await index.get()).manifest;
    assert.equal(m.sized, 0);
    assert.equal(m.totalBytes, null);
    assert.ok(m.count > 0, 'the list is still complete: the client preloads from the CDN');
    inst.cleanup();
  });
});
