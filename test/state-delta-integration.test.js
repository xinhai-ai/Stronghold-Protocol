import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StateReceiver } from '../shared/stateDelta.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';
import { StubMatch } from '../server/match/StubMatch.js';

async function fixture(t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
    announcementsFile: null, resyncMinGapMs: 100, ...opts });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async (delta, token = undefined) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    c.welcome = await c.request({ t: 'hello', name: 'Player' + clients.length, token,
      version: PROTOCOL_VERSION, ...(delta ? { stateDelta: 1 } : {}) });
    c.id = c.welcome.playerId;
    return c;
  };
  return { srv, connect };
}

test('real four-player room: mixed clients, exact public delta, private isolation, spectator, full resync/reconnect', async (t) => {
  const { srv, connect } = await fixture(t);
  const modern = await connect(true), legacy = await connect(false), p3 = await connect(true), p4 = await connect(true);
  assert.equal((await modern.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await modern.waitFor('room.state');
  for (const c of [legacy, p3, p4]) {
    assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
    await c.request({ t: 'room.ready', ready: true });
  }
  assert.equal((await modern.request({ t: 'room.start' })).t, 'ok');
  const rx = new StateReceiver();
  const fullPub = await modern.waitFor('m.state', (m) => m.kind === 'm.public');
  const fullPriv = await modern.waitFor('m.state', (m) => m.kind === 'm.private');
  assert.ok(fullPub.full);
  assert.equal(fullPriv.full.playerId, modern.id);
  rx.receive(fullPub); rx.receive(fullPriv);
  const oldPub = await legacy.waitFor('m.public'), oldPriv = await legacy.waitFor('m.private');
  assert.deepEqual(fullPub.full, oldPub);
  assert.equal(oldPriv.playerId, legacy.id);
  assert.ok(!legacy.log.some((m) => m.t === 'm.state'));
  const match = srv.lobby.rooms.get(room.code).match;
  await modern.request({ t: 'g.infoReady' });
  const delta = await modern.waitFor('m.state', (m) => m.kind === 'm.public' && m.patch);
  const updated = rx.receive(delta).message;
  const { serverNow: _now, ...actual } = updated;
  const { serverNow: _expectedNow, ...expected } = match.publicView();
  assert.deepEqual(actual, expected);
  assert.equal(updated.players.find((p) => p.playerId === modern.id).ready, true);
  const spectator = await connect(true);
  await spectator.request({ t: 'room.spectate', code: room.code });
  assert.ok((await spectator.waitFor('m.state', (m) => m.kind === 'm.public')).full);
  assert.ok(!spectator.log.some((m) => m.kind === 'm.private' || m.t === 'm.private'));
  // A dropped application frame asks for full recovery; no untrusted state is uploaded.
  await modern.request({ t: 'state.resync' });
  const recoveredPub = await modern.waitFor('m.state', (m) => m.kind === 'm.public' && m.full);
  const recoveredPriv = await modern.waitFor('m.state', (m) => m.kind === 'm.private' && m.full);
  assert.equal(recoveredPriv.full.playerId, modern.id);
  assert.equal(recoveredPub.full.players.find((p) => p.playerId === modern.id).ready, true);
  await modern.terminate();
  const back = await connect(true, modern.welcome.token);
  assert.equal(back.welcome.resumed, true);
  assert.equal(back.id, modern.id);
  assert.ok((await back.waitFor('m.state', (m) => m.kind === 'm.public')).full);
  assert.ok((await back.waitFor('m.state', (m) => m.kind === 'm.private')).full);
});

test('standalone FIFO matchmaking also uses delta transport, without sending a private view to another owner', async (t) => {
  const { connect } = await fixture(t);
  const clients = [];
  for (let i = 0; i < 4; i++) {
    const c = await connect(i !== 1);
    clients.push(c);
    assert.equal((await c.request({ t: 'match.join', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  }
  for (let i = 0; i < 4; i++) {
    const c = clients[i];
    if (i === 1) assert.equal((await c.waitFor('m.private')).playerId, c.id);
    else {
      assert.ok((await c.waitFor('m.state', (m) => m.kind === 'm.public')).full);
      assert.equal((await c.waitFor('m.state', (m) => m.kind === 'm.private')).full.playerId, c.id);
    }
  }
  await clients[0].request({ t: 'g.infoReady' });
  assert.ok((await clients[0].waitFor('m.state', (m) => m.kind === 'm.public' && m.patch)).patch);
  await clients[0].request({ t: 'hello', name: 'Repeat', version: PROTOCOL_VERSION, stateDelta: 1 });
  assert.ok((await clients[0].waitFor('m.state', (m) => m.kind === 'm.public' && m.full)).full);
  assert.equal((await clients[0].waitFor('m.state', (m) => m.kind === 'm.private' && m.full)).full.playerId, clients[0].id);
});

test('modern result replay is full after reconnect; a second match starts with independent baselines', async (t) => {
  const { srv, connect } = await fixture(t, { MatchClass: StubMatch });
  const c = await connect(true);
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const room = await c.waitFor('room.state');
  await c.request({ t: 'room.start' });
  await c.waitFor('m.state', (m) => m.kind === 'm.public');
  await c.waitFor('m.state', (m) => m.kind === 'm.private');
  await c.request({ t: 'g.infoReady' });
  await c.waitFor('m.result');
  const recorded = srv.lobby.rooms.get(room.code).replay;
  assert.equal(JSON.parse(recorded.publicFrame).t, 'm.public', 'stored replay is independent of negotiated transport');
  await c.terminate();
  const back = await connect(true, c.welcome.token);
  const replay = await back.waitFor('m.state', (m) => m.kind === 'm.public');
  assert.equal(replay.full.phase, 'RESULT');
  await back.waitFor('m.result');
  await back.request({ t: 'room.start' });
  const start = await back.waitFor('m.state', (m) => m.kind === 'm.public' && m.full?.phase === 'INFO_CHECK');
  assert.ok(start.full);
  assert.equal((await back.waitFor('m.state', (m) => m.kind === 'm.private')).full.playerId, back.id);
});
