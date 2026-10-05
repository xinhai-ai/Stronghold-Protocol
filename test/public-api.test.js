import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { createPublicApi, roomStatus } from '../server/publicApi.js';
import { TestClient } from './helpers/wsClient.js';

async function boot(t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
    announcementsFile: null, ...opts });
  t.after(() => srv.close());
  return srv;
}
function request(srv, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function player(t, srv, name) {
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => client.close());
  const welcome = await client.hello(name);
  client.id = welcome.playerId;
  return client;
}

test('ping supports GET/HEAD/OPTIONS and CORS without creating sessions or rooms', async (t) => {
  const srv = await boot(t);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
    const r = await request(srv, '/api/ping?probe=1', { method, headers: { Origin: 'https://other.example' } });
    assert.equal(r.status, method === 'OPTIONS' ? 204 : method === 'POST' ? 405 : 200);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
    assert.equal(r.headers['cache-control'], 'no-store');
    if (method === 'HEAD' || method === 'OPTIONS') assert.equal(r.body, '');
    else assert.deepEqual(JSON.parse(r.body), method === 'GET' ? { ok: true } : { error: 'METHOD_NOT_ALLOWED' });
  }
  assert.equal(srv.registry.size, 0);
  assert.equal(srv.lobby.rooms.size, 0);
});

test('room query reports lobby and match lifecycle, includes AI and excludes spectators and private fields', async (t) => {
  const srv = await boot(t);
  const host = await player(t, srv, '房主');
  const peer = await player(t, srv, '队友');
  const watcher = await player(t, srv, '观战者');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const state = await host.waitFor('room.state');
  const room = srv.lobby.getRoom(state.code);
  assert.equal((await peer.request({ t: 'room.join', code: state.code })).t, 'ok');
  assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await watcher.request({ t: 'room.spectate', code: state.code })).t, 'ok');
  assert.equal((await peer.request({ t: 'room.ready', ready: true })).t, 'ok');
  const path = `/api/rooms/${state.code}/status`;
  const lobby = await request(srv, path.toLowerCase().replace('/api', '/API') + '?unused=1');
  assert.equal(lobby.status, 200);
  assert.equal(lobby.headers['cache-control'], 'no-store');
  assert.equal(lobby.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  assert.equal(lobby.headers['access-control-allow-origin'], undefined);
  const data = JSON.parse(lobby.body);
  assert.deepEqual([data.code, data.mode, data.difficulty, data.difficultyName], [state.code, 'coop', 'NORMAL', '险境模拟']);
  assert.deepEqual([data.capacity, data.occupied, data.humans, data.bots, data.connectedHumans], [4, 3, 2, 1, 2]);
  assert.deepEqual([data.inMatch, data.joinable, data.phase, data.round, data.lastRound, data.deadline, data.paused],
    [false, true, 'LOBBY', 0, null, 0, false]);
  assert.equal(data.seats[0].isHost, true);
  assert.equal(data.seats[1].ready, true);
  assert.equal(data.seats[2].isBot, true);
  assert.equal(data.seats[3], null);
  assert.ok(Number.isFinite(data.serverNow));
  assert.ok(!/playerId|token|loadout|board|shop|spectators/.test(lobby.body));
  const head = await request(srv, path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  const published = await host.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
  const inMatch = JSON.parse((await request(srv, path)).body);
  assert.equal(inMatch.inMatch, true);
  assert.equal(inMatch.joinable, false);
  assert.equal(inMatch.phase, published.phase);
  assert.equal(inMatch.lastRound, published.lastRound);
  assert.equal(inMatch.deadline, published.deadline);
  assert.equal(inMatch.seats[0].lp, published.players.find((p) => p.playerId === host.id).lp);
  assert.equal(inMatch.seats[0].pendingLp, 0);
  room.match.finish({ victory: false, reason: 'test' });
  const ended = JSON.parse((await request(srv, path)).body);
  assert.equal(ended.phase, 'LOBBY');
  assert.equal(ended.inMatch, false);
  assert.equal('lp' in ended.seats[0], false);
  srv.lobby.disposeRoom(room, 'empty');
  assert.equal((await request(srv, path)).status, 404);
});

test('solo capacity is one and is never joinable; room route rejects malformed codes and trailing slashes', async (t) => {
  const srv = await boot(t);
  const host = await player(t, srv, '独立');
  await host.request({ t: 'room.create', mode: 'solo', difficulty: 'ABYSS' });
  const state = await host.waitFor('room.state');
  const solo = JSON.parse((await request(srv, `/api/rooms/${state.code}/status`)).body);
  assert.equal(solo.capacity, 1);
  assert.equal(solo.seats.length, 1);
  assert.equal(solo.joinable, false);
  assert.equal(solo.difficultyName, '终极模拟');
  for (const path of ['/api/rooms', '/api/rooms/ABIO/status', '/api/rooms/AB1D/status', '/api/rooms/ABC/status',
    `/api/rooms/${state.code}/status/`, '/api/rooms/AAAA/status']) {
    const r = await request(srv, path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(JSON.parse(r.body), { error: 'ROOM_NOT_FOUND' });
  }
  const unsupported = await request(srv, '/api/rooms', { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.allow, 'GET, HEAD');
  assert.deepEqual(JSON.parse(unsupported.body), { error: 'METHOD_NOT_ALLOWED' });
  assert.equal((await request(srv, '/api/rooms', { method: 'HEAD' })).body, '');
});

test('status uses published pause/LP state, preserves disconnected/departed seats and strips private data', () => {
  const room = { code: 'ABCD', mode: 'coop', difficulty: 'HARD', hostId: 'p1', match: {},
    seats: [{ seat: 0, playerId: 'p1', name: 'A', connected: true, left: true, ready: true, loadout: 'secret' },
      { seat: 1, playerId: 'p2', name: 'B', connected: false }, null, null],
    matchCtx: { lastPublic: JSON.stringify({ phase: 'COMBAT', round: 8, lastRound: 14, deadline: 123, paused: true,
      players: [{ playerId: 'p1', ready: false, alive: true, lp: 30, pendingLp: 3, board: 'secret' },
        { playerId: 'p2', alive: false, lp: null }] }) } };
  const status = roomStatus(room, 999);
  assert.equal(status.paused, true);
  assert.deepEqual([status.occupied, status.humans, status.connectedHumans], [2, 2, 0]);
  assert.deepEqual(status.seats[0], { seat: 0, name: 'A', isBot: false, isHost: true, connected: false,
    ready: false, alive: true, lp: 30, pendingLp: 3 });
  assert.equal(status.seats[1].lp, null);
  assert.equal(status.seats[1].pendingLp, 0);
  assert.equal(status.serverNow, 999);
});

test('query rate limit includes local requests, failed queries and methods; refills at 2/s with IPv6 /64 grouping', async () => {
  let at = 1000;
  const make = (trustProxy) => createPublicApi({ lobby: { getRoom() { return null; } }, trustProxy, now: () => at,
    sendJson(req, res, status, body) { res.status = status; res.body = body; }, sendError() {} });
  const api = make('auto');
  const query = async (router, ip, forwarded, method = 'GET') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    await router({ method, socket: { remoteAddress: ip }, headers: forwarded ? { 'x-real-ip': forwarded } : {} }, res, '/api/rooms');
    return res;
  };
  for (let i = 0; i < 10; i++) assert.equal((await query(api, '127.0.0.1', null, i % 2 ? 'POST' : 'GET')).status, i % 2 ? 405 : 404);
  const denied = await query(api, '127.0.0.1', null, 'POST');
  assert.equal(denied.status, 429, 'rate limiting precedes method validation');
  assert.deepEqual(denied.body, { error: 'RATE_LIMITED' });
  assert.equal(denied.headers['Retry-After'], '1');
  at += 499;
  assert.equal((await query(api, '127.0.0.1')).status, 429);
  at += 1;
  assert.equal((await query(api, '127.0.0.1')).status, 404);
  assert.equal((await query(api, '127.0.0.1')).status, 429);
  for (let i = 0; i < 10; i++) assert.equal((await query(api, '127.0.0.1', '2001:db8:1:2::1')).status, 404);
  assert.equal((await query(api, '127.0.0.1', '2001:db8:1:2::abcd')).status, 429);
  assert.equal((await query(api, '127.0.0.1', '2001:db8:1:3::1')).status, 404);
  const untrusted = make(false);
  for (let i = 0; i < 10; i++) await query(untrusted, '127.0.0.1', `203.0.113.${i + 1}`);
  assert.equal((await query(untrusted, '127.0.0.1', '203.0.113.99')).status, 429, 'TRUST_PROXY=0 ignores spoofed headers');
});

test('room rate limit is wired before the global method guard and applies over real HTTP', async (t) => {
  const srv = await boot(t);
  for (let i = 0; i < 10; i++) await request(srv, '/api/rooms', { method: 'POST' });
  const denied = await request(srv, '/api/rooms', { method: 'POST' });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['retry-after'], '1');
  assert.deepEqual(JSON.parse(denied.body), { error: 'RATE_LIMITED' });
  assert.equal((await request(srv, '/api/ping')).status, 200, 'ping does not share the query budget');
});

test('announcement API projects the active schedule, computes absolute expiry and hashes public content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-public-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'announcements.json');
  const start = Date.parse('2026-10-05T11:55:00+08:00');
  const row = { id: 'internal-id', text: '维护通知', startAt: new Date(start).toISOString(), durationSeconds: 300 };
  await writeFile(file, JSON.stringify({ announcements: [row] }));
  const srv = await boot(t, { announcementsFile: file });
  let at = start + 60000;
  srv.announcements.now = () => at;
  const read = async () => {
    const r = await request(srv, '/api/announcement');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    return JSON.parse(r.body);
  };
  const first = await read();
  assert.equal(first.serverTime, at);
  assert.deepEqual(Object.keys(first.announcement).sort(), ['expiresAt', 'id', 'text', 'title']);
  assert.equal(first.announcement.title, '维护公告');
  assert.equal(first.announcement.expiresAt, start + 300000);
  assert.match(first.announcement.id, /^[0-9a-f]{24}$/);
  at += 10000;
  assert.equal((await read()).announcement.id, first.announcement.id, 'reading later does not extend expiry or change the id');
  const head = await request(srv, '/api/announcement', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  for (const change of [{ title: '计划维护' }, { text: '新正文' }, { durationSeconds: 301 }]) {
    await writeFile(file, JSON.stringify({ announcements: [{ ...row, ...change }] }));
    await srv.announcements.reload();
    assert.notEqual((await read()).announcement.id, first.announcement.id);
  }
  at = start + 301000;
  assert.equal((await read()).announcement, null, 'the end boundary is exclusive');
  at = start - 1;
  assert.equal((await read()).announcement, null, 'future notices are not active');
  at = start + 1;
  await writeFile(file, '{invalid');
  await srv.announcements.reload();
  assert.equal((await read()).announcement, null, 'invalid config is not exposed as a current notice');
  await rm(file);
  await srv.announcements.reload();
  assert.equal((await read()).announcement, null);
  await writeFile(file, JSON.stringify({ announcements: [{ ...row, enabled: false }] }));
  await srv.announcements.reload();
  assert.equal((await read()).announcement, null);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const denied = await request(srv, '/api/announcement', { method });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.allow, 'GET, HEAD');
    assert.match(denied.headers['content-type'], /^text\/html/);
  }
});
