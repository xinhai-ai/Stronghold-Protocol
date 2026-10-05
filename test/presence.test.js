import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

let srv;
const clients = [];

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  await srv?.close();
});

test('presence is pushed over WebSocket as authenticated clients join and leave', async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const a = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(a);
  const welcomeA = await a.hello('A');
  assert.equal(welcomeA.online, 1);

  const b = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(b);
  const welcomeB = await b.hello('B');
  assert.equal(welcomeB.online, 2);
  assert.equal((await a.waitFor('presence', (m) => m.online === 2)).online, 2);

  await b.terminate();
  assert.equal((await a.waitFor('presence', (m) => m.online === 1)).online, 1);
});
