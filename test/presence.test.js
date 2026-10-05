import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { EventEmitter } from 'node:events';
import { Network, SessionRegistry, PRESENCE_INTERVAL_MS } from '../server/net.js';

let srv;
const clients = [];

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  await srv?.close();
});

test('presence refreshes WebSocket clients every two seconds, including unchanged counts', async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const a = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(a);
  const welcomeA = await a.hello('A');
  assert.equal(welcomeA.online, 1);

  const b = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(b);
  const welcomeB = await b.hello('B');
  assert.equal(welcomeB.online, 2);
  const first = await a.waitFor('presence', (m) => m.online === 2, 3000);
  const unchanged = await a.waitFor('presence', (m) => m.online === 2 && m.serverNow > first.serverNow, 3000);
  assert.ok(unchanged.serverNow - first.serverNow >= 1900);

  await b.terminate();
  assert.equal((await a.waitFor('presence', (m) => m.online === 1, 3000)).online, 1);
});

test('join/leave do not trigger presence outside the fixed schedule; shutdown clears its timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10000 });
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
  t.after(() => network.close());
  const socket = () => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.bufferedAmount = 0;
    ws.frames = [];
    ws.send = (data) => ws.frames.push(JSON.parse(data));
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    ws.terminate = ws.close;
    network.handleConnection(ws);
    return ws;
  };
  const a = socket(), title = socket();
  const hello = (ws, name) => ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, version: 1 })), false);
  const presence = (ws) => ws.frames.filter((m) => m.t === 'presence');
  hello(a, 'A');
  assert.equal(a.frames.find((m) => m.t === 'welcome').online, 1);
  t.mock.timers.tick(PRESENCE_INTERVAL_MS - 1);
  assert.equal(presence(a).length, 0, 'hello does not broadcast immediately');
  t.mock.timers.tick(1);
  assert.deepEqual(presence(a), [{ t: 'presence', online: 1, serverNow: 12000 }]);
  assert.deepEqual(presence(title), presence(a), 'title sockets keep receiving public presence');
  const b = socket();
  hello(b, 'B');
  assert.equal(b.frames.find((m) => m.t === 'welcome').online, 2);
  t.mock.timers.tick(PRESENCE_INTERVAL_MS - 1);
  assert.equal(presence(a).length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(presence(a).at(-1), { t: 'presence', online: 2, serverNow: 14000 });
  t.mock.timers.tick(PRESENCE_INTERVAL_MS);
  assert.deepEqual(presence(a).at(-1), { t: 'presence', online: 2, serverNow: 16000 }, 'unchanged count is refreshed');
  b.close();
  assert.equal(presence(a).length, 3, 'disconnect does not broadcast immediately');
  t.mock.timers.tick(PRESENCE_INTERVAL_MS);
  assert.deepEqual(presence(a).at(-1), { t: 'presence', online: 1, serverNow: 18000 });
  const broadcast = t.mock.method(network, 'broadcastPresence');
  network.close();
  t.mock.timers.tick(PRESENCE_INTERVAL_MS * 3);
  assert.equal(broadcast.mock.callCount(), 0, 'shutdown cancels the periodic broadcast');
});
