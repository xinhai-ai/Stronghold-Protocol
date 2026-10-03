// test/resources/common.test.js — the pure half of the optional offline-resource preload (public/js/resources/common.js,
// docs/ASSETS.md「Preload」): the manifest the server serves, URL rules, byte text and Range replies.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_NAME, CACHE_PREFIX, HASH_RE, INDEX_PATH, MAX_FILE_BYTES, RESOURCES_FORMAT, TIER_ESSENTIAL, TIER_REST, cacheName,
  absoluteUrl, formatBytes, indexUrl, isQuotaError, isResourcePath, isResourceUrl, resourceType, validateManifest,
  rangeResponse, checkAbort, abortError,
} from '../../public/js/resources/common.js';

describe('resource manifest validation', () => {
  test('a well-formed manifest passes and is returned as is', () => {
    const m = { format: RESOURCES_FORMAT, version: 'abc-1', count: 2, totalBytes: 30, files: [{ url: '/assets/a.png', tier: 1, size: 10 }, { url: 'https://cdn.example.com/assets/b.skel', tier: 2, size: 20 }] };
    assert.equal(validateManifest(m), m);
  });

  test('a broken manifest throws (the preload must stay off rather than hammer the origin)', () => {
    const ok = { format: RESOURCES_FORMAT, version: 'v', files: [{ url: '/assets/a.png', tier: 1 }] };
    assert.throws(() => validateManifest(null), /格式/);
    assert.throws(() => validateManifest({ ...ok, format: 2 }), /格式/);
    assert.throws(() => validateManifest({ ...ok, version: '' }), /版本/);
    assert.throws(() => validateManifest({ ...ok, files: null }), /文件列表/);
    assert.throws(() => validateManifest({ ...ok, files: Array.from({ length: 50001 }, () => ({ url: '/assets/a.png', tier: 1 })) }), /过大/);
    assert.throws(() => validateManifest({ ...ok, files: [{ url: 'javascript:alert(1).png', tier: 1 }] }), /无效/);
    assert.throws(() => validateManifest({ ...ok, files: [{ url: '/assets/a.png', tier: 3 }] }), /分层/);
    assert.throws(() => validateManifest({ ...ok, files: [{ url: '/assets/a.png', tier: 1, size: -1 }] }), /大小/);
    assert.throws(() => validateManifest({ ...ok, files: [{ url: '/assets/a.png', tier: 1, size: 1.5 }] }), /大小/);
    // a huge file is allowed (imported) — the store skips it, the manifest stays usable
    assert.equal(validateManifest({ ...ok, files: [{ url: '/assets/a.png', tier: 1, size: MAX_FILE_BYTES + 1 }] }).files.length, 1);
  });

  test('the per-file hash is optional but must be usable when present', () => {
    const base = { format: RESOURCES_FORMAT, version: 'v' };
    // absent (a server of an older build / a manifest without hashes) and both shapes the server writes
    for (const hash of [undefined, 'c72412846779', 'syn-07572a8a157e', 'sha1-abc']) {
      const files = [{ url: '/assets/a.png', tier: 1, ...(hash === undefined ? {} : { hash }) }];
      assert.equal(validateManifest({ ...base, files }).files[0].hash, hash);
    }
    assert.equal(HASH_RE.test('syn-07572a8a157e'), true);
    // anything the store would compare but never match, or that could blow up the index entry
    assert.throws(() => validateManifest({ ...base, files: [{ url: '/assets/a.png', tier: 1, hash: '' }] }), /指纹/);
    assert.throws(() => validateManifest({ ...base, files: [{ url: '/assets/a.png', tier: 1, hash: 42 }] }), /指纹/);
    assert.throws(() => validateManifest({ ...base, files: [{ url: '/assets/a.png', tier: 1, hash: 'x'.repeat(65) }] }), /指纹/);
    assert.throws(() => validateManifest({ ...base, files: [{ url: '/assets/a.png', tier: 1, hash: 'a/b' }] }), /指纹/);
  });

  test('URL rules: site paths and CDN URLs yes, everything else no', () => {
    for (const url of ['/assets/char/avatar/char_002_amiya.png', '/fonts/bender.woff2', '/assets/local/map/autochess/TX_D.png',
      'https://cdn.example.com/assets/spine/op/x/front/x.skel', 'http://127.0.0.1:8080/assets/x.atlas']) {
      assert.equal(isResourceUrl(url), true, url);
    }
    for (const url of ['', '/data/assets.json', '/js/main.js', 'assets/relative.png', '//cdn.example.com/assets/x.png',
      '/assets/x.png?', '/assets/x', '/assets/x.unknown', 'javascript:alert(1).png', 'data:image/png;base64,AA',
      'https://cdn.example.com/data/x.json', '/assets/x.png#frag', '/assets/a b.png', `/${'a'.repeat(600)}.png`]) {
      assert.equal(isResourceUrl(url), false, url);
    }
    assert.equal(isResourceUrl(null), false);
    assert.equal(isResourceUrl(42), false);
  });

  test('paths, MIME types and cache names', () => {
    assert.equal(isResourcePath('/assets/x.png'), true);
    assert.equal(isResourcePath('/fonts/x.woff2'), true);
    assert.equal(isResourcePath('/data/assets.json'), false);
    assert.equal(resourceType('/assets/x.png'), 'image/png');
    assert.equal(resourceType('https://cdn/x.SKEL'), 'application/octet-stream');
    assert.equal(resourceType('/assets/x.json'), null);
    assert.equal(cacheName('deadbeef'), `${CACHE_PREFIX}deadbeef`);
    assert.equal(cacheName(undefined), `${CACHE_PREFIX}none`);
    assert.equal(CACHE_NAME.startsWith(CACHE_PREFIX), true, 'the store uses one cache of this app');
    assert.equal(INDEX_PATH.startsWith('/assets'), false, 'the index is not a resource path the worker would answer');
    assert.equal(isResourcePath(INDEX_PATH), false);
    assert.equal(indexUrl('https://site.example'), `https://site.example${INDEX_PATH}`);
    assert.equal(indexUrl('https://cdn.example'), `https://cdn.example${INDEX_PATH}`);
    assert.equal(absoluteUrl('/assets/x.png', 'https://site.example'), 'https://site.example/assets/x.png');
    assert.equal(absoluteUrl('https://cdn.example/assets/x.png', 'https://site.example'), 'https://cdn.example/assets/x.png');
    assert.equal(absoluteUrl('::::', 'https://site.example'), 'https://site.example/::::', 'a relative string resolves');
    assert.equal(absoluteUrl('/assets/x.png', 'not a url'), null);
  });

  test('byte text and abort helpers', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MiB');
    assert.equal(formatBytes(259726913), '248 MiB');
    assert.equal(formatBytes(-1), '—');
    assert.equal(formatBytes(NaN), '—');
    const ac = new AbortController();
    checkAbort(ac.signal);
    assert.equal(abortError('stop').name, 'AbortError');
    ac.abort();
    assert.throws(() => checkAbort(ac.signal), (err) => err.name === 'AbortError');
    const stopped = new AbortController();
    stopped.abort(new Error('paused by the player'));
    assert.throws(() => checkAbort(stopped.signal), /paused by the player/);
    assert.equal(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true);
    assert.equal(isQuotaError(new Error('The quota has been exceeded.')), true);
    assert.equal(isQuotaError(new Error('Storage is full')), true);
    assert.equal(isQuotaError(new Error('404')), false);
    assert.equal(isQuotaError(null), false);
    assert.equal(TIER_ESSENTIAL, 1);
    assert.equal(TIER_REST, 2);
  });
});

describe('range replies from a cached response', () => {
  const cached = () => new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg' } });

  test('a byte range answers 206 with just those bytes', async () => {
    const res = await rangeResponse(cached(), 'bytes=2-5');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), 'bytes 2-5/10');
    assert.equal(res.headers.get('Content-Length'), '4');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await res.text(), '2345');
  });

  test('open-ended and suffix ranges', async () => {
    assert.equal(await (await rangeResponse(cached(), 'bytes=7-')).text(), '789');
    assert.equal(await (await rangeResponse(cached(), 'bytes=-3')).text(), '789');
    assert.equal(await (await rangeResponse(cached(), 'bytes=0-99')).text(), '0123456789');
  });

  test('an unsatisfiable range answers 416 (media players stop asking)', async () => {
    const res = await rangeResponse(cached(), 'bytes=20-30');
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await rangeResponse(cached(), 'bytes=abc').then((r) => r.status), 416);
    assert.equal(await rangeResponse(cached(), '').then((r) => r.status), 416);
  });
});
