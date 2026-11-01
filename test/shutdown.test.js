import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { handle, ipHash } from '../deploy/shutdown/worker.js';
import { exportData, preferenceBackup, clearResourceCaches, clearPersonalData } from '../deploy/shutdown/site/data.js';
import { parseImport } from '../public/js/ui/loadoutModel.js';
import { importStats, emptyStats, buildRecord } from '../public/js/ui/stats.js';
const schema = readFileSync(new URL('../deploy/shutdown/migrations/0001_messages.sql', import.meta.url), 'utf8');
function environment() {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema);
  return { sql, SITE_ORIGIN: 'https://game.test', TURNSTILE_SECRET_KEY: 'secret', IP_HASH_SECRET: 'private-key',
    DB: { prepare(query) { return { bind(...args) { return {
      async run() { return sql.prepare(query).run(...args); },
      async all() { return { results: sql.prepare(query).all(...args) }; },
    }; } }; } },
  };
}
const verify = async () => Response.json({ success: true, hostname: 'game.test', action: 'farewell' });
function post({ ip = '192.0.2.1', origin = 'https://game.test', data = {}, raw } = {}) {
  return new Request('https://game.test/api/messages', { method: 'POST',
    headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify({ name: '博士', body: '后会有期', token: 'test-token', ...data }),
  });
}
test('homepage GET and HEAD serve the canonical asset without a redirect loop', async () => {
  const calls = [];
  const env = { ASSETS: { async fetch(request) {
    const url = new URL(request.url);
    calls.push({ path: url.pathname, query: url.search, method: request.method });
    // Model the documented default Workers Assets HTML canonicalization.
    if (url.pathname === '/index.html') return new Response(null, { status: 307, headers: { Location: '/' } });
    assert.equal(url.pathname, '/');
    return new Response(request.method === 'HEAD' ? null : '<!doctype html><title>Farewell</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    });
  } } };
  for (const path of ['/', '/index.html']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await handle(new Request(`https://game.test${path}?check=1`, { method }), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Location'), null);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match(response.headers.get('Content-Type'), /^text\/html/);
      assert.equal(await response.text(), method === 'HEAD' ? '' : '<!doctype html><title>Farewell</title>');
    }
  }
  assert.deepEqual(calls, ['GET', 'HEAD', 'GET', 'HEAD'].map(method => ({ path: '/', query: '?check=1', method })));
});
test('asset and retired WebSocket paths keep their own responses', async () => {
  const env = { ASSETS: { async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/assets/app.js');
    return new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } });
  } } };
  const asset = await handle(new Request('https://game.test/assets/app.js'), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'export {}');
  assert.equal((await handle(new Request('https://game.test/ws'), env)).status, 410);
});
test('concurrent submissions commit only five per IP; deletion does not refund quota', async () => {
  const env = environment();
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => handle(post(), env, verify)));
    assert.equal(responses.filter(r => r.status === 201).length, 5);
    assert.equal(responses.filter(r => r.status === 429).length, 15);
    env.sql.exec('DELETE FROM messages');
    assert.equal((await handle(post(), env, verify)).status, 429);
    assert.equal((await handle(post({ ip: '192.0.2.2' }), env, verify)).status, 201);
  } finally { env.sql.close(); }
});
test('failed insert rolls back quota increment', () => {
  const env = environment();
  try {
    assert.throws(() => env.sql.prepare('INSERT INTO messages(ip_hash,name,body) VALUES(?,?,?)').run('hash', '博士', ''));
    assert.equal(env.sql.prepare('SELECT count(*) AS n FROM ip_quota').get().n, 0);
  } finally { env.sql.close(); }
});
test('validation fails closed, validates action/hostname and never consumes quota', async () => {
  const env = environment();
  try {
    for (const result of [{ success: false }, { success: true, hostname: 'evil.test', action: 'farewell' }, { success: true, hostname: 'game.test', action: 'other' }]) {
      assert.equal((await handle(post(), env, async () => Response.json(result))).status, 403);
    }
    assert.equal((await handle(post(), env, async () => { throw new Error('offline'); })).status, 503);
    for (const request of [post({ origin: 'https://evil.test' }), post({ data: { body: 'x'.repeat(501) } }), post({ data: { token: '' } }), post({ raw: 'x'.repeat(9000) }), post({ raw: 'null' })]) {
      assert.ok((await handle(request, env, verify)).status >= 400);
    }
    assert.equal(env.sql.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
    assert.equal((await handle(post(), { ...env, TURNSTILE_SECRET_KEY: '' }, verify)).status, 503);
    assert.equal((await worker.fetch(new Request('https://game.test/'), {})).status, 503);
  } finally { env.sql.close(); }
});
test('messages remain available only in the administrator database, never through public reads', async () => {
  const env = environment();
  try {
    const response = await handle(post(), env, verify);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(env.sql.prepare('SELECT body FROM messages').get().body, '后会有期');
    const noReads = { ...env, DB: { prepare() { assert.fail('public requests must not query messages'); } } };
    for (const path of ['/api/messages', '/api/messages?before=100', '/api/messages/1']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const result = await handle(new Request(`https://game.test${path}`, { method }), noReads);
        assert.equal(result.status, 404);
        assert.deepEqual(await result.json(), { error: '接口不存在或请求方法不支持' });
        assert.equal(result.headers.get('Cache-Control'), 'no-store');
      }
    }
  } finally { env.sql.close(); }
});
test('IP key is stable HMAC, secret dependent; verification receives server secret and IP', async () => {
  assert.equal(await ipHash('192.0.2.1', 'a'), await ipHash('192.0.2.1', 'a'));
  assert.notEqual(await ipHash('192.0.2.1', 'a'), await ipHash('192.0.2.1', 'b'));
  const env = environment();
  try {
    await handle(post(), env, async (url, options) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(options.body.get('secret'), 'secret');
      assert.equal(options.body.get('remoteip'), '192.0.2.1');
      return verify();
    });
  } finally { env.sql.close(); }
});
function storage(values) {
  const map = new Map(Object.entries(values));
  return { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: k => map.get(k) ?? null, removeItem: k => map.delete(k) };
}
test('loadout export round trips skills/modules and operator potential/cultivate', () => {
  const original = { v: 1, entries: { char_test: { skill: 1, module: 'mod_test' } }, ops: { char_test: { potential: 3, cultivate: 1 } } };
  const result = exportData('loadout', storage({ 'sp.pref.loadout': JSON.stringify(original) }));
  const parsed = parseImport(JSON.stringify(result));
  assert.deepEqual(parsed.entries, original.entries); assert.deepEqual(parsed.ops, original.ops);
});
test('statistics export round trips real history, and never writes storage', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stats-results.json', import.meta.url), 'utf8'));
  const record = buildRecord(fixture['solo-normal'], { myId: 'p_0', now: 1700000000000 });
  const raw = { v: 2, records: [record] };
  const local = storage({ 'sp.pref.stats': JSON.stringify(raw) });
  const result = exportData('stats', local);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, record.id);
  assert.deepEqual(importStats(result, emptyStats()).stats.records, [record]);
  assert.equal(local.getItem('sp.pref.stats'), JSON.stringify(raw));
  assert.throws(() => exportData('stats', storage({ 'sp.pref.stats': '{broken' })));
  assert.throws(() => exportData('stats', storage({ 'sp.pref.stats': '{"v":99,"records":[]}' })));
});
test('raw preference backup excludes identity and unrelated origin data', () => {
  const local = storage({ 'sp.pref.stats.damaged': '{broken', 'sp.pref.loadout': '{}', 'sp.tokens': 'secret', other: 'keep' });
  assert.deepEqual({ ...preferenceBackup(local).values }, { 'sp.pref.stats.damaged': '{broken', 'sp.pref.loadout': '{}' });
});
test('cache cleanup touches only game resource caches; personal cleanup preserves unrelated keys', async () => {
  const deleted = [];
  assert.equal(await clearResourceCaches({ keys: async () => ['stronghold-resources-v1-all', 'other-app'], delete: async k => deleted.push(k) }), 1);
  assert.deepEqual(deleted, ['stronghold-resources-v1-all']);
  const local = storage({ 'sp.pref.stats': '{}', 'sp.tokens': 'keep', other: 'keep' });
  const databases = [];
  await clearPersonalData(local, { deleteDatabase(name) { databases.push(name); const req = {}; queueMicrotask(() => req.onsuccess()); return req; } });
  assert.deepEqual(databases, ['sp-hub-backdrop', 'sp-lobby-music']);
  assert.equal(local.getItem('sp.pref.stats'), null); assert.equal(local.getItem('other'), 'keep'); assert.equal(local.getItem('sp.tokens'), 'keep');
});
