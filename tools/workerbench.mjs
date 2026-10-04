#!/usr/bin/env node
// Production simulation-pool benchmark: deterministic results, throughput and main-thread timer delay.
// node tools/workerbench.mjs --workers 4 --battles 24
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { getData } from '../server/data.js';
import { DataSource, spawnsFromTemplate } from '../server/sim/simdata.js';
import { buildBattleSpec, createBattleFromSpec, resultDigest } from '../server/sim/spec.js';
import { runHeadless } from '../server/match/fields.js';
import { SimulationPool, workerSettings } from '../server/workers/pool.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const workers = option('workers', workerSettings().size || 1);
const count = option('battles', 24);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('--battles must be 1..10000');
const data = getData({ log: { warn() {}, info() {}, error() {} } });
const ds = new DataSource(data, null);
const wave = spawnsFromTemplate(ds.getWave('act1autochess_h05'), { mods: { hpMul: 3 } });
const lineup = [
  ['chess_char_1_02_a', 9, 7], ['chess_char_2_09_a', 9, 4], ['chess_char_4_09_a', 12, 5],
  ['chess_char_3_08_a', 12, 7], ['chess_char_1_01_a', 10, 4], ['chess_char_1_03_a', 11, 4],
  ['chess_char_2_02_a', 12, 4], ['chess_char_2_14_a', 10, 5], ['chess_char_5_12_a', 11, 5], ['chess_char_6_13_a', 9, 8],
];
const tasks = Array.from({ length: count }, (_, seed) => ({ players: ['p'], spec: buildBattleSpec({
  seed: seed + 1, fieldId: 'n:p', kind: 'normal', stageId: 'act2autochess_m01', timeLimit: wave.maxPlayTime,
  routes: wave.routes, spawns: wave.spawns,
  players: [{ playerId: 'p', units: lineup.map(([chessId, row, col], i) => ({ uid: i + 1, kind: 'chess', chessId, row, col, abs: true })) }],
}) }));
const local = (payload) => runHeadless(createBattleFromSpec(payload.spec, ds, { recordEvents: false, quiet: true }), { players: payload.players }).result;
const pool = new SimulationPool({ data, size: workers, maxQueue: count });
async function measure(run) {
  let previous = performance.now(), maxTimerDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerDelayMs = Math.max(maxTimerDelayMs, now - previous - 10);
    previous = now;
  }, 10);
  try {
    const started = performance.now();
    const results = await run();
    const elapsedMs = performance.now() - started;
    await delay(20); // let the timer observe any synchronous stall
    return { elapsedMs: +elapsedMs.toFixed(1), battlesPerSecond: +(count * 1000 / elapsedMs).toFixed(2),
      maxTimerDelayMs: +Math.max(0, maxTimerDelayMs).toFixed(1), hashes: results.map((r) => resultDigest(r).hash) };
  } finally { clearInterval(timer); }
}
try {
  for (let i = 0; i < 2; i++) local(tasks[0]);
  await Promise.all(Array.from({ length: workers }, () => pool.submit('battle', tasks[0]).promise));
  const baseline = await measure(() => tasks.map(local));
  const parallel = await measure(async () => (await Promise.all(tasks.map((p) => pool.submit('battle', p).promise))).map((o) => o.result));
  const identical = baseline.hashes.every((hash, i) => hash === parallel.hashes[i]);
  delete baseline.hashes;
  delete parallel.hashes;
  console.log(JSON.stringify({ node: process.version, workers, battles: count, identical, baseline, parallel }, null, 2));
  if (!identical) process.exitCode = 1;
} finally { await pool.close(); }
