import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createNameModeration, createCombinedNameModeration, createJevNameModeration, nameModerationFromEnv, DEFAULT_LEXICON_URL, JEV_ENDPOINT, lexiconEndpoint } from '../server/nameModeration.js';
import { Network, SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { Net, NetError, checkNameBeforeHello } from '../public/js/net.js';
import { ERR, ERR_TEXT, NAME_MAX_LEN, PROTOCOL_VERSION } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const answer = (contains = false) => ({ contains });
const response = (data = answer(), status = 200) => new Response(JSON.stringify(data), { status });
const service = (fetchFn, extra = {}) => createNameModeration({ fetchFn, ...extra });

test('rejection uses generic name feedback without review disclosure or unavailable-service hints', () => {
  assert.equal(ERR_TEXT.NAME_REJECTED, '该名称不可用');
  assert.equal(new NetError(ERR.NAME_REJECTED).message, '该名称不可用');
  assert.equal(ERR.NAME_REVIEW_UNAVAILABLE, undefined);
  assert.equal(ERR_TEXT.NAME_REVIEW_UNAVAILABLE, undefined);
  const title = readFileSync(new URL('../public/js/screens/title.js', import.meta.url), 'utf8');
  assert.doesNotMatch(title, /启用用户名审核时|敏感词服务检测|用户名审核暂不可用/);
  for (const language of ['en', 'ja', 'ko', 'zh-TW']) {
    const messages = JSON.parse(readFileSync(new URL(`../public/i18n/${language}.json`, import.meta.url), 'utf8'));
    assert.ok(messages['该名称不可用']);
    assert.ok(!Object.keys(messages).some((key) => /用户名不符合本服务器|启用用户名审核时|用户名审核暂不可用/.test(key)));
  }
});

test('approved hello retains token ownership, state-delta negotiation and complete Match Worker routing', async (t) => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, matchWorkers: 1, store: null,
    nameModeration: { async check(name) { return name === 'Blocked' ? { allowed: false, code: ERR.NAME_REJECTED } : { allowed: true }; } } });
  t.after(() => srv.close());
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const owner = await TestClient.connect(url);
  const other = await TestClient.connect(url);
  t.after(async () => { await owner.close(); await other.close(); });
  const welcome = await owner.request({ t: 'hello', name: 'Policy', version: PROTOCOL_VERSION, stateDelta: 1 });
  assert.equal(welcome.t, 'welcome');
  assert.equal((await other.request({ t: 'hello', name: 'Blocked', token: welcome.token, version: PROTOCOL_VERSION })).code, ERR.NAME_REJECTED);
  assert.equal((await other.request({ t: 'hello', name: 'Policy', token: welcome.token,
    noReplace: true, version: PROTOCOL_VERSION })).code, ERR.SESSION_IN_USE);
  assert.equal([...srv.registry.all()].length, 1);
  assert.equal((await owner.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const code = (await owner.waitFor('room.state')).code;
  assert.equal((await owner.request({ t: 'room.start' }, 10000)).t, 'ok');
  await owner.waitFor('m.state', (m) => m.kind === 'm.public' && m.full?.phase === 'INFO_CHECK');
  const match = srv.lobby.getRoom(code).match;
  assert.equal(match.remote, true);
  const checkpoint = await match.snapshot();
  assert.equal(checkpoint.players[0].playerId, welcome.playerId);
  assert.equal((await owner.request({ t: 'g.infoReady' })).t, 'ok');
  assert.equal(srv.registry.byToken(welcome.token).name, 'Policy');
});

test('Sensitive-lexicon contains=true blocks, contains=false allows', async () => {
  for (const contains of [false, true]) {
    const m = service(async () => response(answer(contains)));
    assert.deepEqual(await m.check('测试昵称'), contains ? { allowed: false, code: ERR.NAME_REJECTED } : { allowed: true }); m.close();
  }
});

test('Docker API contract sends only sanitized text, no key/model, cache snapshots stay independent', async () => {
  let calls = 0;
  const m = service(async (url, init) => {
    calls++; assert.equal(url, DEFAULT_LEXICON_URL + '/contains');
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { text: '博士' });
    return response();
  });
  const result = await m.check(' 博\u200b士 '); assert.equal(result.allowed, true);
  result.allowed = false;
  assert.equal((await m.check('博士')).allowed, true); assert.equal(calls, 1); m.close();
});

test('lexicon config supports Docker host/prefix, explicit off; invalid URL/mode fails startup', () => {
  assert.equal(nameModerationFromEnv({}), null);
  const jevDefault = nameModerationFromEnv({ TYPESAFE_API_KEY: 'test-key' }); assert.equal(jevDefault.mode, 'jev'); jevDefault.close();
  assert.equal(nameModerationFromEnv({ SP_NAME_MODERATION: 'off', SP_NAME_MODERATION_URL: 'broken' }), null);
  for (const env of [{ SP_NAME_MODERATION: 'lexicon' }, { SP_NAME_MODERATION_URL: 'http://lexicon:8080' }]) {
    const m = nameModerationFromEnv(env); assert.ok(m); m.close();
  }
  const jev = nameModerationFromEnv({ SP_NAME_MODERATION: 'jev', TYPESAFE_API_KEY: 'test-key' }); assert.equal(jev.mode, 'jev'); jev.close();
  const both = nameModerationFromEnv({ SP_NAME_MODERATION: 'both', SP_NAME_MODERATION_URL: 'http://lexicon:8080', TYPESAFE_API_KEY: 'test-key' }); assert.equal(both.mode, 'both'); both.close();
  assert.throws(() => nameModerationFromEnv({ SP_NAME_MODERATION: 'jev' }), /TYPESAFE_API_KEY/);
  assert.throws(() => nameModerationFromEnv({ SP_NAME_MODERATION: 'both', TYPESAFE_API_KEY: 'test-key' }), /SP_NAME_MODERATION_URL/);
  assert.throws(() => nameModerationFromEnv({ SP_NAME_MODERATION: 'both', SP_NAME_MODERATION_URL: 'http://lexicon:8080' }), /TYPESAFE_API_KEY/);
  for (const mode of ['typo']) assert.throws(() => nameModerationFromEnv({ SP_NAME_MODERATION: mode }), /must be/);
  for (const url of ['bad', 'file:///test', 'ftp://localhost', 'http://user:pass@localhost', 'http://localhost?q=1', 'http://localhost/#x']) assert.throws(() => nameModerationFromEnv({ SP_NAME_MODERATION_URL: url }), /URL/);
  assert.equal(lexiconEndpoint('http://lexicon:8080/'), 'http://lexicon:8080/contains');
  assert.equal(lexiconEndpoint('https://review.internal/api/'), 'https://review.internal/api/contains');
});

for (const [label, fetchFn] of [
  ['401', async () => response({}, 401)], ['429', async () => response({}, 429)],
  ['529', async () => response({}, 529)], ['network', async () => { throw new Error('secret upstream details'); }],
  ['bad JSON', async () => new Response('broken')], ['missing contains', async () => response({})],
  ['null contains', async () => response({ contains: null })],
  ['string contains', async () => response({ contains: 'false' })],
  ['numeric contains', async () => response({ contains: 0 })],
  ['detect shape', async () => response({ hits: [] })],
]) test(`silently fail open: ${label}, failures are not cached`, async () => {
  let calls = 0; const m = service((...args) => { calls++; return fetchFn(...args); });
  for (let i = 0; i < 2; i++) assert.deepEqual(await m.check('博士'), { allowed: true });
  assert.equal(calls, 2); m.close();
});

test('timeout aborts lexicon request; close aborts active calls without caching results', async () => {
  for (const stop of [false, true]) {
    const m = service((_u, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), { timeoutMs: 15 });
    const task = m.check('博士'); if (stop) m.close();
    assert.deepEqual(await task, { allowed: true }); m.close();
  }
});

test('cache expires, remains bounded, coalesces in-flight calls and enforces concurrency/rate budgets', async () => {
  let now = 0, calls = 0;
  const m = service(async () => { calls++; return response(); }, { now: () => now, cacheLimit: 2, cacheMs: 100 });
  await m.check('A'); await m.check('B'); await m.check('C'); await m.check('A'); assert.equal(calls, 4);
  now = 101; await m.check('A'); assert.equal(calls, 5);
  assert.deepEqual(await m.check('D'), { allowed: true }); m.close();
  const d = deferred(); calls = 0;
  const n = service(async () => { calls++; await d.promise; return response(); }, { maxConcurrent: 1 });
  const p = n.check('A'), q = n.check('A');
  assert.deepEqual(await n.check('B'), { allowed: true }); d.resolve();
  assert.equal((await p).allowed, true); assert.equal((await q).allowed, true); assert.equal(calls, 1); n.close();
});

test('invalid names never invoke lexicon', async () => {
  const m = service(() => { assert.fail('must not call upstream'); });
  for (const name of ['', ' ', null, 3, 'x'.repeat(NAME_MAX_LEN + 1), '\u200b']) assert.equal((await m.check(name)).code, ERR.BAD_MSG);
  m.close();
});

function socket(network) {
  const ws = new EventEmitter(); Object.assign(ws, { readyState: 1, bufferedAmount: 0, frames: [] });
  ws.send = (bytes, cb) => { ws.frames.push(JSON.parse(bytes)); cb?.(); };
  ws.ping = () => {}; ws.close = () => { ws.readyState = 3; ws.emit('close'); }; ws.terminate = ws.close;
  network.handleConnection(ws); return ws;
}
const hello = (ws, name, rid = 1, extra = {}) => ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, rid, version: PROTOCOL_VERSION, ...extra })), false);
const fixture = (t, check) => {
  const registry = new SessionRegistry(); const n = new Network({ registry, handler: { onMessage() {} }, nameModeration: { check } });
  t.after(() => n.close()); return { registry, n };
};

test('raw WS hello cannot bypass review; rejected rename and token takeover leave original identity intact', async (t) => {
  const { n, registry } = fixture(t, async (name) => name === '禁止' ? { allowed: false, code: ERR.NAME_REJECTED } : { allowed: true });
  const ws = socket(n); hello(ws, '禁止'); await turn(); assert.equal(registry.size, 0); assert.equal(ws.frames.at(-1).code, ERR.NAME_REJECTED);
  assert.equal(ws.frames.at(-1).msg, '该名称不可用');
  hello(ws, '博士', 2); await turn(); const welcome = ws.frames.at(-1); assert.equal(welcome.t, 'welcome');
  hello(ws, '禁止', 3); await turn(); assert.equal(registry.byToken(welcome.token).name, '博士');
  const other = socket(n); hello(other, '禁止', 4, { token: welcome.token }); await turn();
  assert.equal(other.frames.at(-1).code, ERR.NAME_REJECTED); assert.equal(ws.readyState, 1); assert.equal(registry.size, 1);
  hello(other, '新博士', 5, { token: welcome.token }); await turn();
  assert.equal(other.frames.at(-1).resumed, true); assert.equal(registry.size, 1); assert.equal(ws.readyState, 3);
});

test('latest hello wins; discarded results, closed sockets and shutdown cannot mint sessions', async (t) => {
  const jobs = new Map(); const { n, registry } = fixture(t, (name) => { const d = deferred(); jobs.set(name, d); return d.promise; });
  const ws = socket(n); hello(ws, 'old'); hello(ws, 'new', 2); await turn();
  jobs.get('new').resolve({ allowed: true }); await turn();
  jobs.get('old').resolve({ allowed: true }); await turn(); assert.equal(registry.size, 1); assert.equal(ws.frames.at(-1).name, 'new');
  const closed = socket(n); hello(closed, 'closed'); await turn(); closed.close(); jobs.get('closed').resolve({ allowed: true }); await turn(); assert.equal(registry.size, 1);
  const shutting = socket(n); hello(shutting, 'shutdown'); await turn(); n.beginShutdown(); jobs.get('shutdown').resolve({ allowed: true }); await turn(); assert.equal(registry.size, 1);
});

test('WS review exceptions silently fail open; actions wait for review but ping stays responsive', async (t) => {
  const d = deferred(); const { n, registry } = fixture(t, () => d.promise);
  const ws = socket(n); hello(ws, '博士');
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'ping', c: 1, rid: 2 })), false); assert.equal(ws.frames.at(-1).t, 'pong');
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'g.leave', rid: 3 })), false); assert.equal(ws.frames.at(-1).code, ERR.RATE);
  d.resolve({ allowed: false }); await turn(); assert.equal(ws.frames.at(-1).t, 'welcome'); assert.equal(registry.size, 1);
  n.nameModeration.check = () => { throw new Error('private upstream response'); }; hello(ws, '博士', 4); await turn();
  assert.equal(ws.frames.at(-1).t, 'welcome'); assert.ok(!ws.frames.some((msg) => msg.t === 'error' && msg.rid === 4)); assert.ok(!JSON.stringify(ws.frames).includes('private upstream'));
});

function client(t, moderateName) {
  const sockets = [];
  class FakeWS {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const net = new Net({ url: 'ws://test/ws', WebSocket: FakeWS, moderateName, getToken: () => 'token' });
  t.after(() => net.close()); net.setName('博士'); sockets[0].open(); return { net, ws: sockets[0], sockets };
}

test('client sends no hello until approval and coalesces identical names', async (t) => {
  const d = deferred(); let calls = 0;
  const { net, ws } = client(t, () => { calls++; return d.promise; });
  net.setName('博士'); await turn(); assert.equal(calls, 1); assert.ok(!ws.sent.some((m) => m.t === 'hello'));
  d.resolve({ allowed: true }); await turn(); const msg = ws.sent.find((m) => m.t === 'hello'); assert.equal(msg.name, '博士'); assert.equal(msg.token, 'token');
});

test('client rejects explicit violations but silently sends hello on network failure', async (t) => {
  const { net, ws } = client(t, async (name) => name === '博士' ? { allowed: false, code: ERR.NAME_REJECTED } : { allowed: true });
  const errors = []; net.on('helloError', (e) => errors.push(e.code)); await turn();
  assert.equal(net.status, 'connected'); assert.deepEqual(errors, [ERR.NAME_REJECTED]); assert.ok(!ws.sent.some((m) => m.t === 'hello'));
  net.setName('新名字'); await turn(); assert.equal(ws.sent.at(-1).name, '新名字');
  const bad = client(t, () => { throw new Error('fetch failed'); }); await turn();
  assert.ok(bad.ws.sent.some((m) => m.t === 'hello')); assert.equal(bad.net.lastError, null);
});

test('client stale checks cannot send old names or use old sockets', async (t) => {
  const jobs = new Map();
  const { net, ws, sockets } = client(t, (name, signal) => { const d = deferred(); jobs.set(name, { ...d, signal }); return d.promise; });
  await turn(); net.setName('新名字'); await turn(); assert.equal(jobs.get('博士').signal.aborted, true);
  jobs.get('博士').resolve({ allowed: true }); await turn(); assert.ok(!ws.sent.some((m) => m.t === 'hello'));
  jobs.get('新名字').resolve({ allowed: true }); await turn(); assert.equal(ws.sent.at(-1).name, '新名字');
  net.reconnectNow(); sockets.at(-1).open(); await turn(); net.close(); jobs.get('新名字').resolve({ allowed: true }); await turn();
  assert.ok(!sockets.at(-1).sent.some((m) => m.t === 'hello'));
});

test('client timeout silently sends one normal hello without a warning', async (t) => {
  const { net, ws } = client(t, () => new Promise(() => {}));
  // Exercise the same abort timer callback without waiting seven seconds.
  await turn(); net._nameCheck.controller.abort(); await turn();
  assert.equal(net.lastError, null); assert.equal(net.status, 'handshaking');
  assert.equal(ws.sent.filter((m) => m.t === 'hello').length, 1);
});

test('browser HTTP helper blocks only explicit rejections, silently allows review failures', async () => {
  let init;
  assert.equal((await checkNameBeforeHello('博士', undefined, async (url, options) => { assert.equal(url, '/api/name-moderation'); init = options; return response({ allowed: true }); })).allowed, true);
  assert.deepEqual(await checkNameBeforeHello('博士', undefined, async () => response({ allowed: false, code: ERR.NAME_REJECTED }, 422)), { allowed: false, code: ERR.NAME_REJECTED });
  assert.deepEqual(await checkNameBeforeHello('博士', undefined, async () => response({ allowed: false, code: ERR.BAD_MSG }, 400)), { allowed: false, code: ERR.BAD_MSG });
  assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.deepEqual(JSON.parse(init.body), { name: '博士' });
  for (const r of [response({ allowed: true }, 503), response({}), new Response('<html>')]) {
    assert.equal((await checkNameBeforeHello('博士', undefined, async () => r)).allowed, true);
  }
});

test('real HTTP and WS share approval cache; route limits/methods/privacy and UTF-8 chunking', async (t) => {
  let calls = 0;
  const m = service(async () => { calls++; return response(); });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, announcementsFile: null, nameModeration: m });
  t.after(() => srv.close());
  const url = srv.url + '/api/name-moderation';
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const approved = await post(JSON.stringify({ name: '博士' })); assert.equal(approved.status, 200); assert.equal(approved.headers.get('cache-control'), 'no-store');
  assert.equal(approved.headers.get('access-control-allow-origin'), null); assert.deepEqual(await approved.json(), { allowed: true });
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await post('broken')).status, 400);
  assert.equal((await post(JSON.stringify({ name: ' ' }))).status, 400);
  assert.equal((await post(JSON.stringify({ name: '博士' }), { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('x'.repeat(1100))).status, 413);
  const splitResult = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let body = ''; res.on('data', (b) => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject); const bytes = Buffer.from(JSON.stringify({ name: '博士' })); const offset = bytes.indexOf(Buffer.from('博')) + 1;
    req.write(bytes.subarray(0, offset)); setImmediate(() => req.end(bytes.subarray(offset)));
  });
  assert.equal(splitResult.status, 200); assert.equal(calls, 1);
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws'); t.after(() => ws.terminate());
  const welcome = new Promise((resolve, reject) => { ws.on('error', reject); ws.on('message', (b) => { const msg = JSON.parse(b.toString()); if (msg.t === 'welcome') resolve(msg); }); });
  await new Promise((resolve) => ws.once('open', resolve)); ws.send(JSON.stringify({ t: 'hello', name: '博士', rid: 1, version: PROTOCOL_VERSION }));
  assert.equal((await welcome).name, '博士'); assert.equal(calls, 1); assert.equal(srv.registry.size, 1);
});


test('explicit name rejection returns to editable title, without clearing tokens or match state', async () => {
  const { returnToTitleAfterNameReview } = await import('../public/js/screens/title.js');
  const { createStore, selectRoute } = await import('../public/js/store.js');
  const state = createStore({ session: { entered: true }, me: { name: '博士' }, room: { code: 'ABCD' }, match: { public: { phase: 'PREP' } } });
  let entered = true;
  const identity = { setEntered(value) { entered = value; } };
  assert.equal(returnToTitleAfterNameReview({ code: ERR.NAME_REJECTED }, { status: 'connected' }, identity, state), true);
  assert.equal(entered, false); assert.equal(selectRoute(state.get()), 'title');
  assert.equal(state.get().room.code, 'ABCD'); assert.equal(state.get().match.public.phase, 'PREP');
  state.patch('session', { entered: true });
  assert.equal(returnToTitleAfterNameReview({ code: ERR.NAME_REJECTED }, { status: 'online' }, identity, state), false);
  assert.equal(state.get().session.entered, true);
  assert.equal(returnToTitleAfterNameReview({ code: ERR.INTERNAL }, { status: 'connected' }, identity, state), false);
});

test('server recheck rejection after preapproval also preserves accepted session on rename', async (t) => {
  const { net, ws } = client(t, async () => ({ allowed: true })); await turn();
  const initial = ws.sent.at(-1);
  ws.onmessage({ data: JSON.stringify({ t: 'welcome', rid: initial.rid, playerId: 'p1', name: '博士', token: 't' }) });
  net.setName('新名字'); await turn(); const rename = ws.sent.at(-1);
  ws.onmessage({ data: JSON.stringify({ t: 'error', rid: rename.rid, code: ERR.NAME_REJECTED }) });
  assert.equal(net.status, 'online'); assert.equal(net.name, '博士'); assert.equal(net.serverName, '博士');
});


test('HTTP and raw WS review failures allow silently, no fallback approval cache', async (t) => {
  let calls = 0;
  const moderation = service(async () => { calls++; throw new Error('upstream unavailable'); });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, announcementsFile: null, nameModeration: moderation });
  t.after(() => srv.close());
  const res = await fetch(srv.url + '/api/name-moderation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '博士' }) });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { allowed: true });
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws'); t.after(() => ws.terminate());
  const frames = [];
  const welcome = new Promise((resolve, reject) => { ws.on('error', reject); ws.on('message', (b) => { const msg = JSON.parse(b.toString()); frames.push(msg); if (msg.t === 'welcome') resolve(msg); }); });
  await new Promise((resolve) => ws.once('open', resolve)); ws.send(JSON.stringify({ t: 'hello', name: '博士', rid: 1, version: PROTOCOL_VERSION }));
  assert.equal((await welcome).name, '博士'); assert.equal(calls, 2); assert.ok(!frames.some((msg) => msg.t === 'error'));
});

test('HTTP unexpected reviewer exception and client unavailable result also silently allow', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, announcementsFile: null,
    nameModeration: { check() { throw new Error('private provider error'); } } });
  t.after(() => srv.close());
  const res = await fetch(srv.url + '/api/name-moderation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '博士' }) });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { allowed: true });
  const { net, ws } = client(t, async () => ({ allowed: false, code: 'NAME_REVIEW_UNAVAILABLE' }));
  const errors = []; net.on('helloError', (e) => errors.push(e)); await turn();
  assert.equal(ws.sent.filter((msg) => msg.t === 'hello').length, 1); assert.deepEqual(errors, []); assert.equal(net.lastError, null);
});


test('real lexicon HTTP contract feeds preflight and WS; fresh instance clears cache', async (t) => {
  const calls = [];
  const backend = http.createServer((req, res) => {
    let body = ''; req.on('data', (b) => { body += b; }); req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body), method: req.method });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const contains = JSON.parse(body).text.includes('测试违禁词');
      res.end(JSON.stringify({ contains, ...(contains ? { word: '测试违禁词' } : {}) }));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => backend.close(resolve)));
  const baseUrl = `http://127.0.0.1:${backend.address().port}`;
  const m = createNameModeration({ baseUrl });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, announcementsFile: null, nameModeration: m }); t.after(() => srv.close());
  for (const [name, status] of [['博士', 200], ['含测试违禁词的昵称', 422]]) {
    const res = await fetch(srv.url + '/api/name-moderation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(res.status, status); assert.deepEqual(await res.json(), status === 200 ? { allowed: true } : { allowed: false, code: ERR.NAME_REJECTED });
  }
  assert.deepEqual(calls, [{ url: '/contains', body: { text: '博士' }, method: 'POST' }, { url: '/contains', body: { text: '含测试违禁词的昵称' }, method: 'POST' }]);
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws'); t.after(() => ws.terminate());
  const rejected = new Promise((resolve, reject) => { ws.on('error', reject); ws.on('message', (b) => { const msg = JSON.parse(b.toString()); if (msg.rid === 1) resolve(msg); }); });
  await new Promise((resolve) => ws.once('open', resolve)); ws.send(JSON.stringify({ t: 'hello', name: '含测试违禁词的昵称', rid: 1, version: PROTOCOL_VERSION }));
  assert.equal((await rejected).code, ERR.NAME_REJECTED); assert.equal(calls.length, 2); assert.equal(srv.registry.size, 0);
  // A fresh instance has no approval/rejection baseline from the old lexicon version.
  const fresh = createNameModeration({ baseUrl }); t.after(() => fresh.close()); await fresh.check('博士'); assert.equal(calls.length, 3);
});


test('Jev sends official systemone Noul request and blocks an explicit category', async () => {
  let calls = 0;
  const answers = Object.fromEntries(['politics', 'violence', 'sexual', 'illegal'].map((key) => [key, { type: 'noul', noul: key === 'politics' ? 0.5 : 0.01 }]));
  const jev = createJevNameModeration({ apiKey: 'test-key', fetchFn: async (url, init) => {
    calls++; assert.equal(url, JEV_ENDPOINT); assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body); assert.deepEqual(body.state, { username: '博士' }); assert.equal(body.model, 'jev-latest');
    assert.equal(Object.keys(body.questions).length, 4); return response({ answers });
  }});
  assert.deepEqual(await jev.check(' 博​士 '), { allowed: false, code: ERR.NAME_REJECTED }); assert.equal(calls, 1); jev.close();
});

test('both runs backends independently: one explicit rejection blocks, one failure silently allows', async () => {
  const lexicon = { check: async () => ({ allowed: false, code: ERR.NAME_REJECTED }), close() {} };
  const jev = { check: async () => { throw new Error('Jev unavailable'); }, close() {} };
  const both = createCombinedNameModeration([lexicon, jev], 'both');
  assert.equal(both.mode, 'both'); assert.deepEqual(await both.check('博士', 'local'), { allowed: false, code: ERR.NAME_REJECTED }); both.close();
  const allow = createCombinedNameModeration([{ check: async () => ({ allowed: true }) }, { check: async () => { throw new Error('down'); } }], 'both');
  assert.deepEqual(await allow.check('博士'), { allowed: true }); allow.close();
});

test('both preserves a rejection even when the other backend is slow', async () => {
  const slow = new Promise(() => {});
  const both = createCombinedNameModeration([{ check: async () => ({ allowed: false, code: ERR.NAME_REJECTED }) }, { check: () => slow }], 'both');
  const result = await Promise.race([both.check('博士'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))]);
  assert.deepEqual(result, { allowed: false, code: ERR.NAME_REJECTED }); both.close();
});
