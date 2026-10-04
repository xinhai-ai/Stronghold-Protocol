import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SimulationPool, workerSettings } from '../server/workers/pool.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { DATA, makeMatch } from './match/harness.js';
import { PHASE } from '../shared/constants.js';
import { createBattleFromSpec, resultDigest, compactResult } from '../server/sim/spec.js';
import { runHeadless } from '../server/match/fields.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../server/match/bot.js';

const fixture = new URL('./fixtures/pool-worker.mjs', import.meta.url);
const fixturePool = (opts = {}) => new SimulationPool({ size: 1, workerUrl: fixture, ...opts });
async function until(pred) {
  const deadline = Date.now() + 10000;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail('condition did not complete');
    await delay(5);
  }
}

function combat() {
  const h = makeMatch({ humans: 2, seed: 9112, clientCombat: true, clients: false });
  h.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  return h;
}

test('worker settings honor CPU budget, disabled mode and bounded overrides', () => {
  assert.equal(workerSettings({}, 1).size, 1);
  assert.equal(workerSettings({}, 32).size, 8);
  assert.equal(workerSettings({ SP_WORKERS: '0' }, 8).size, 0);
  assert.equal(workerSettings({ SP_WORKERS: '-1' }, 8).size, 6);
  assert.deepEqual(workerSettings({ SP_WORKERS: '3', SP_WORKER_QUEUE: '9', SP_WORKER_TIMEOUT_MS: '456' }),
    { size: 3, maxQueue: 9, timeoutMs: 456 });
});

test('bounded queue, priority, queued cancellation, and thread reuse', async (t) => {
  const pool = fixturePool({ maxQueue: 2 });
  t.after(() => pool.close());
  const active = pool.submit('burn', { ms: 100, value: 'active' });
  const cancelled = pool.submit('burn', { value: 'cancelled' });
  const cancellation = assert.rejects(cancelled.promise, { code: 'TASK_CANCELLED' });
  cancelled.cancel();
  await cancellation;
  const order = [];
  const low = pool.submit('burn', { value: 'low' });
  const high = pool.submit('burn', { value: 'high' }, { priority: 2 });
  low.promise.then((x) => order.push(x));
  high.promise.then((x) => order.push(x));
  await assert.rejects(pool.submit('burn', {}).promise, { code: 'POOL_FULL' });
  assert.equal(await active.promise, 'active');
  await Promise.all([low.promise, high.promise]);
  assert.deepEqual(order, ['high', 'low']);
  assert.equal(pool.stats().threads, 1);
  assert.equal(pool.stats().completed, 3);
  assert.ok(pool.stats().avgComputeMs > 0);
  assert.equal(pool.stats().avgComputeMs, pool.stats().computeMs / pool.stats().completed);
});

test('worker CPU does not block the parent event loop', async (t) => {
  const pool = fixturePool();
  t.after(() => pool.close());
  await pool.submit('burn', {}).promise; // exclude startup
  let done = false;
  const work = pool.submit('burn', { ms: 150 }).promise.then(() => { done = true; });
  await delay(20);
  assert.equal(done, false, 'the main thread handles timers while a worker computes');
  await work;
});

test('crashed / timed out workers are replaced; running cancellation and shutdown settle promises', async (t) => {
  const pool = fixturePool({ timeoutMs: 5000 });
  t.after(() => pool.close());
  await assert.rejects(pool.submit('crash', {}).promise, { code: 'WORKER_FAILED' });
  assert.equal(await pool.submit('burn', { value: 7 }).promise, 7);
  pool.timeoutMs = 50;
  await assert.rejects(pool.submit('hang', {}).promise, { code: 'TASK_TIMEOUT' });
  pool.timeoutMs = 5000;
  assert.equal(await pool.submit('burn', { value: 8 }).promise, 8);
  const active = pool.submit('burn', { ms: 100 });
  const cancelled = assert.rejects(active.promise, { code: 'TASK_CANCELLED' });
  active.cancel();
  await cancelled;
  const queued = pool.submit('burn', {});
  const closed = assert.rejects(queued.promise, { code: 'POOL_CLOSED' });
  await pool.close();
  await closed;
  await assert.rejects(pool.submit('burn', {}).promise, { code: 'POOL_CLOSED' });
});

test('real battle worker results and progress timelines equal the local simulation', async (t) => {
  const pool = new SimulationPool({ data: DATA, size: 2 });
  t.after(() => pool.close());
  const h = combat();
  t.after(() => h.m.dispose());
  const specs = h.m.fields.map((f) => ({ spec: f.spec, players: f.players }));
  const expected = specs.map(({ spec, players }) => runHeadless(createBattleFromSpec(spec, h.m.ds, { recordEvents: false }), { players }));
  const actual = await Promise.all(specs.map((payload) => pool.submit('battle', payload).promise));
  actual.forEach((out, i) => {
    assert.equal(resultDigest(out.result).hash, resultDigest(expected[i].result).hash);
    assert.deepEqual(out.result, expected[i].result);
    assert.deepEqual(out.timeline, expected[i].timeline);
    assert.deepEqual(out.errors, expected[i].battle.errors);
  });
});

test('AI candidate scores select the identical plan and leave board / economy untouched', async (t) => {
  const pool = new SimulationPool({ data: DATA, size: 1 });
  t.after(() => pool.close());
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 4, botRehearsal: 0 });
  t.after(() => h.m.dispose());
  h.m.order[0].autoplay = true;
  h.start();
  h.run(() => h.m.phase === PHASE.PREP && h.m.round === 3);
  const m = h.m, ps = m.order[0];
  m.botRehearsal = 3;
  const chosen = ps.allChess().slice(0, ps.deployCap);
  assert.ok(chosen.length >= 3);
  const plans = REHEARSAL_VARIANTS.map((v) => planLayout(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  const snapshot = () => JSON.stringify({ board: [...ps.board], hand: ps.hand, funds: ps.funds, layers: ps.layers, pool: m.pool.snapshot() });
  const before = snapshot();
  const local = createRehearsal(m, ps, chosen, plans);
  assert.ok(local);
  local.run();
  m.workerPool = pool; // manually exercise input capture on the same virtual fixture
  const remote = createRehearsal(m, ps, chosen, plans);
  assert.equal(snapshot(), before);
  const result = await pool.submit('rehearsal', remote.workerPayload).promise;
  assert.equal(result.bestIndex, local.plans.indexOf(local.best));
  assert.equal(snapshot(), before);
});

test('strict verification waits, ignores duplicates, and replaces a plausible forged result', async (t) => {
  const pool = new SimulationPool({ data: DATA, size: 1 });
  t.after(() => pool.close());
  const h = combat();
  t.after(() => h.m.dispose());
  const m = h.m, f = m.fields[0];
  m.workerPool = pool;
  m.verifyMode = 'all';
  const honest = runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false }), { players: f.players }).result;
  const forged = compactResult(honest);
  for (const pp of Object.values(forged.perPlayer)) { pp.leaked = []; pp.perfect = true; pp.killed = pp.total; }
  const msg = { t: 'b.result', battleId: f.battleId, result: forged };
  assert.deepEqual(m.handle('p_0', msg), { ok: true });
  m.handle('p_0', msg);
  assert.equal(f.verifying, true);
  assert.equal(f.done, false);
  assert.equal(f.result, null);
  assert.equal(pool.stats().submitted, 1);
  await until(() => f.done);
  assert.equal(m.verifyStats.checked, 1);
  assert.equal(m.verifyStats.mismatches, 1);
  assert.ok(f.result.perPlayer.p_0.leaked.length > 0);
});

test('strict verification failure uses server computation; late results cannot mutate replaced fields', async (t) => {
  const h = combat();
  t.after(() => h.m.dispose());
  const m = h.m, f = m.fields[0];
  let reject, cancellations = 0;
  const promise = new Promise((_, no) => { reject = no; });
  m.workerPool = { submit: () => ({ promise, cancel: () => { cancellations++; } }) };
  m.verifyMode = 'all';
  const result = compactResult(runHeadless(createBattleFromSpec(f.spec, m.ds), { players: f.players }).result);
  m.handle('p_0', { t: 'b.result', battleId: f.battleId, result });
  reject(Object.assign(new Error('full'), { code: 'POOL_FULL' }));
  await delay(0);
  assert.equal(f.mode, 'server');
  assert.equal(f.resultSource, 'server'); // virtual fallback ran instantly
  assert.equal(f.verifying, false);
  assert.ok(f.result);

  const other = m.fields[1];
  let late;
  m.workerPool = { submit: () => ({ promise: new Promise((yes) => { late = yes; }), cancel: () => { cancellations++; } }) };
  m._runOnServer(other, 'disconnect');
  m._clearFieldTimers(other);
  const original = other.result;
  late({ result, timeline: [], time: 0, errors: [] });
  await delay(0);
  assert.equal(other.result, original);
  assert.ok(cancellations > 0);
});

test('sampling computes asynchronously without changing an accepted result', async (t) => {
  const h = combat();
  t.after(() => h.m.dispose());
  const m = h.m, f = m.fields[0];
  f.battleId = '8'; // the stable hash selects this field for sampling
  m.verifyMode = 'sample';
  let resolve;
  m.workerPool = { submit: () => ({ promise: new Promise((yes) => { resolve = yes; }), cancel() {} }) };
  const actual = runHeadless(createBattleFromSpec(f.spec, m.ds), { players: f.players }).result;
  const forged = compactResult(actual);
  for (const pp of Object.values(forged.perPlayer)) { pp.leaked = []; pp.perfect = true; pp.killed = pp.total; }
  m.handle('p_0', { t: 'b.result', battleId: '8', result: forged });
  assert.equal(f.done, true);
  const accepted = f.result;
  assert.equal(m.verifyStats.checked, 0);
  resolve({ result: actual });
  await delay(0);
  assert.equal(m.verifyStats.checked, 1);
  assert.equal(m.verifyStats.mismatches, 1);
  assert.equal(f.result, accepted);
  assert.equal(f.result.perPlayer.p_0.leaked.length, 0);
});

test('a paused solo match holds the verified result until resume', async (t) => {
  const h = combat();
  t.after(() => h.m.dispose());
  const m = h.m, f = m.fields[0];
  m.isSolo = true;
  m.verifyMode = 'all';
  let resolve;
  m.workerPool = { submit: () => ({ promise: new Promise((yes) => { resolve = yes; }), cancel() {} }) };
  const actual = runHeadless(createBattleFromSpec(f.spec, m.ds), { players: f.players }).result;
  m.handle('p_0', { t: 'b.result', battleId: f.battleId, result: compactResult(actual) });
  m.setPause(m.players.get('p_0'), true);
  assert.equal(m.paused, true);
  resolve({ result: actual, errors: [] });
  await delay(0);
  assert.equal(f.done, false);
  assert.equal(f.verifying, true);
  m.setPause(m.players.get('p_0'), false);
  assert.equal(f.done, true);
  assert.equal(f.verifying, false);
});

test('bot prep applies the worker-selected plan and cancels its task at the prep deadline', async (t) => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 4 });
  t.after(() => h.m.dispose());
  const m = h.m, ps = m.order[0];
  ps.autoplay = true;
  h.start();
  h.run(() => m.phase === PHASE.PREP && m.round === 3);
  m.botRehearsal = 3;
  m.timerScale = 0;
  let resolve, cancelled = 0;
  m.workerPool = { submit: (type) => {
    assert.equal(type, 'rehearsal');
    return { promise: new Promise((yes) => { resolve = yes; }), cancel: () => { cancelled++; } };
  } };
  m.scheduleBotPrep(ps);
  h.sched.advance(0);
  assert.equal(ps.ready, false);
  assert.ok(resolve);
  resolve({ bestIndex: 1 });
  await delay(0);
  assert.equal(ps.ready, true);
  assert.equal(m.errorCount, 0);

  ps.ready = false;
  m.scheduleBotPrep(ps);
  h.sched.advance(0);
  assert.equal(m.phase, PHASE.PREP);
  const completeLate = resolve;
  m.prepDeadline();
  const before = JSON.stringify([...ps.board]);
  completeLate({ bestIndex: 2 });
  await delay(0);
  assert.equal(JSON.stringify([...ps.board]), before);
  assert.ok(cancelled > 0);
});

test('ordinary takeover keeps natural release timing; disposal cancels running computation', async (t) => {
  const pool = new SimulationPool({ data: DATA, size: 1 });
  t.after(() => pool.close());
  const h = combat();
  t.after(() => h.m.dispose());
  const m = h.m, f = m.fields[0];
  m.workerPool = pool;
  m.onDisconnect('p_0');
  assert.equal(f.mode, 'server');
  assert.equal(f.battle, null, 'simulation is built in the worker');
  await until(() => f.result != null);
  assert.equal(f.done, false);
  assert.ok(f.timeline.length > 1);
  h.sched.advance(0);
  assert.equal(f.done, true);
  m._runOnServer(m.fields[1], 'disconnect');
  m.dispose();
  await delay(0);
  assert.ok(pool.stats().cancelled > 0);
  assert.equal(m._workerTasks.size, 0);
});

test('server shares one pool across matches, reports health, and responds over WS during worker CPU work', async (t) => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 1, store: null });
  t.after(() => srv.close());
  assert.equal(srv.lobby.workerPool, srv.workerPool);
  const health = await (await fetch(`${srv.url}/healthz`)).json();
  assert.equal(health.workers.size, 1);
  assert.equal(health.workers.avgComputeMs, 0);
  const cpu = fixturePool();
  t.after(() => cpu.close());
  await cpu.submit('burn', {}).promise;
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => c.close());
  await c.hello('Worker test');
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const room = await c.waitFor('room.state');
  await c.request({ t: 'room.start' });
  assert.equal(srv.lobby.rooms.get(room.code).match.workerPool, srv.workerPool);
  let done = false;
  const task = cpu.submit('burn', { ms: 300 }).promise.then(() => { done = true; });
  const reply = await c.request({ t: 'ping', c: 12.5 });
  assert.equal(reply.t, 'pong');
  assert.equal(done, false);
  await task;
  await srv.close();
  assert.equal(srv.workerPool.closed, true);
  const disabled = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null });
  t.after(() => disabled.close());
  assert.equal(disabled.workerPool, null);
});
