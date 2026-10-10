import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PersistenceWorker } from '../server/workers/persistenceClient.js';
import { Persister } from '../server/persist.js';
import { captureMatch, snapshotMatch, canSnapshot } from '../server/match/snapshot.js';
import { makeMatch } from './match/harness.js';
import { serialize } from 'node:v8';

test('Worker checkpoints equal the existing snapshot format, including hidden schedules and draft Maps', async (t) => {
  const worker = new PersistenceWorker();
  t.after(() => worker.close());
  const h = makeMatch({ humans: 2, bots: 2, fake: true, seed: 42 });
  t.after(() => h.m.dispose());
  h.start();
  const entries = [{ key: 'TEST', generation: 1 }];
  for (const phase of ['INFO_CHECK', 'BAND_DRAFT', 'PREP', 'SP_DRAFT']) {
    assert.ok(h.drive(() => h.m.phase === phase && canSnapshot(h.m)));
    const expected = snapshotMatch(h.m);
    const capture = captureMatch(h.m);
    const update = worker.request('checkpoint', { ...entries[0], capture });
    // postMessage must clone before another game action can mutate the captured references.
    const funds = h.m.order[0].funds;
    h.m.order[0].funds++;
    await update;
    h.m.order[0].funds = funds;
    const { bytes } = await worker.request('serialize', { entries, doc: {} });
    assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()).matches.TEST, expected);
  }
});

test('Worker keeps the last safe checkpoint and prunes ended or replaced matches', async (t) => {
  const worker = new PersistenceWorker();
  t.after(() => worker.close());
  const h = makeMatch({ humans: 1, bots: 3, fake: true });
  t.after(() => h.m.dispose());
  h.start();
  h.toPrep();
  assert.ok(h.drive(() => canSnapshot(h.m), { ready: false }));
  const capture = captureMatch(h.m);
  await worker.request('checkpoint', { key: 'TEST', generation: 1, capture });
  const entries = [{ key: 'TEST', generation: 1 }];
  const saved = await worker.request('serialize', { entries, doc: { v: 1 } });
  worker.remember(saved.bytes, entries);
  // A worker crash must not erase cached checkpoints during a battle, when no fresh capture is possible.
  worker.drop(worker.worker, new Error('simulated worker failure'));
  const recovered = await worker.request('serialize', { entries, doc: { v: 1 } });
  assert.deepEqual(JSON.parse(Buffer.from(recovered.bytes).toString()).matches,
    JSON.parse(Buffer.from(saved.bytes).toString()).matches);
  const replaced = await worker.request('serialize', { entries: [{ key: 'TEST', generation: 2 }], doc: {} });
  assert.deepEqual(replaced.keys, [], 'new match in the same room cannot inherit an old checkpoint');
});

test('transferred capture bytes retain Maps/hidden schedules, detach the sender buffer, and keep the old JSON format', async (t) => {
  const worker = new PersistenceWorker();
  t.after(() => worker.close());
  const h = makeMatch({ humans: 2, bots: 2, fake: true, seed: 42 });
  t.after(() => h.m.dispose());
  h.start();
  const entries = [{ key: 'TEST', generation: 1 }];
  for (const phase of ['INFO_CHECK', 'BAND_DRAFT', 'PREP', 'SP_DRAFT']) {
    assert.ok(h.drive(() => h.m.phase === phase && canSnapshot(h.m)));
    const expected = snapshotMatch(h.m);
    const bytes = Uint8Array.from(serialize(captureMatch(h.m)));
    const update = worker.request('checkpointBytes', { ...entries[0], bytes }, [bytes.buffer]);
    assert.equal(bytes.byteLength, 0, 'postMessage transfers rather than cloning the buffer');
    const funds = h.m.order[0].funds;
    h.m.order[0].funds++;
    await update;
    h.m.order[0].funds = funds;
    const { bytes: saved } = await worker.request('serialize', { entries, doc: {} });
    assert.deepEqual(JSON.parse(Buffer.from(saved).toString()).matches.TEST, expected);
  }
  const before = await worker.request('serialize', { entries, doc: {} });
  const bad = Uint8Array.from([1, 2, 3]);
  await assert.rejects(worker.request('checkpointBytes', { ...entries[0], bytes: bad }, [bad.buffer]));
  const after = await worker.request('serialize', { entries, doc: {} });
  assert.deepEqual(JSON.parse(Buffer.from(after.bytes).toString()).matches, JSON.parse(Buffer.from(before.bytes).toString()).matches,
    'malformed bytes do not overwrite the last valid checkpoint or poison the Worker');
  assert.equal(worker.pending.size, 0);
});

test('capture failures keep the last checkpoint and do not block other state writes or encode synchronously', async (t) => {
  const h = makeMatch({ humans: 1, fake: true });
  t.after(() => h.m.dispose());
  h.start();
  let writes = 0;
  const persister = new Persister({
    store: { async saveSerialized() { writes++; return true; } },
    registry: { all: () => [] },
    lobby: { rooms: new Map(), persistenceMatches: () => [{ key: 'TEST', match: h.m }] },
  });
  t.after(() => persister.encoder.close());
  h.m.order[0].hand.push(() => {}); // not structured-cloneable
  assert.equal(await persister.flush(), true);
  assert.equal(writes, 1);
  assert.equal(persister.failures, 1);
  h.m.order[0].hand.pop();
  assert.equal(await persister.flush(), true);
  assert.equal(writes, 2);
});

test('restored checkpoints survive combat and a Worker restart before the first save', async (t) => {
  const h = makeMatch({ humans: 1, bots: 3, fake: true });
  t.after(() => h.m.dispose());
  h.start();
  h.toPrep();
  assert.ok(h.drive(() => canSnapshot(h.m), { ready: false }));
  const checkpoint = snapshotMatch(h.m);
  let saved;
  const persister = new Persister({
    store: { async saveSerialized(bytes) { saved = JSON.parse(bytes.toString()); return true; } },
    registry: { all: () => [] },
    lobby: { rooms: new Map(), persistenceMatches: () => [{ key: 'TEST', match: h.m }] },
  });
  t.after(() => persister.encoder.close());
  await persister.seed({ matches: { TEST: checkpoint } });
  persister.encoder.drop(persister.encoder.worker, new Error('simulated startup worker failure'));
  h.m.phase = 'COMBAT';
  assert.equal(await persister.flush(), true);
  assert.deepEqual(saved.matches.TEST, checkpoint, 'a non-checkpointable phase keeps the loaded checkpoint');
});

test('shutdown waits for an in-flight write then saves final state before closing its Worker', async (t) => {
  let release, started;
  const writing = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const docs = [];
  let name = 'before';
  const persister = new Persister({
    store: { async saveSerialized(bytes) {
      docs.push(JSON.parse(bytes.toString()));
      if (docs.length === 1) { started(); await gate; }
      return true;
    } },
    registry: { all: () => [{ playerId: 'p', token: 't', name }] },
    lobby: { rooms: new Map(), persistenceMatches: () => [] },
  });
  t.after(() => persister.encoder.close());
  const first = persister.flush();
  await writing;
  name = 'after';
  const closing = persister.shutdown();
  await nextTurn();
  assert.equal(docs.length, 1, 'no concurrent writes');
  release();
  assert.equal(await first, true);
  assert.equal(await closing, true);
  assert.equal(docs.length, 2);
  assert.equal(docs[1].sessions[0].name, 'after');
  assert.equal(persister.encoder.closed, true);
});
