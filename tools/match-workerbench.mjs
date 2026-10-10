// Match IPC microbenchmark, not an online capacity test. Uses real four-seat Match instances but stale progress
// reports (no battle), no WebSocket/TLS/Redis/browser. Measurements include the lightweight message counters.
// node tools/match-workerbench.mjs --matches 32 --lanes 2 --rounds 100
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { getData } from '../server/data.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? fallback : args[i + 1];
};
const count = Number(arg('matches', 32)), lanes = Number(arg('lanes', 2)), rounds = Number(arg('rounds', 100));
if (!Number.isInteger(count) || count < 1 || count > 1000 || !Number.isInteger(lanes) || lanes < 1 || lanes > 32
  || !Number.isInteger(rounds) || rounds < 1 || rounds > 10000) throw new Error('invalid benchmark options');
const modulePath = arg('pool-module', '');
const { MatchWorkerPool } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : '../server/workers/matchPool.js');
const data = getData({ log: { info() {}, warn() {}, error() {} } });
const datasetJsonBytes = Buffer.byteLength(JSON.stringify(data));
const counters = { configuredDatasets: 0, perMatchDatasets: 0, results: 0, metadataReplies: 0, orderReplies: 0,
  broadcasts: 0, encodedBroadcasts: 0 };
const start = () => ({ wall: performance.now(), cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() });
const stop = (before) => {
  const cpu = process.cpuUsage(before.cpu);
  const elu = performance.eventLoopUtilization(before.elu);
  return { wallMs: +(performance.now() - before.wall).toFixed(2),
    processCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2),
    mainEventLoopActiveMs: +elu.active.toFixed(2), mainEventLoopUtilization: +elu.utilization.toFixed(4) };
};
const before = start();
const pool = new MatchWorkerPool({ data, lanes });
for (const lane of pool.lanes) {
  const post = lane.worker.postMessage.bind(lane.worker);
  lane.worker.postMessage = (message, ...rest) => {
    if (message.type === 'configure' && message.data) counters.configuredDatasets++;
    if (message.type === 'init' && message.options?.data) counters.perMatchDatasets++;
    return post(message, ...rest);
  };
  lane.worker.on('message', (message) => {
    if (message.type === 'result') {
      counters.results++;
      if (message.meta) counters.metadataReplies++;
      if (message.meta?.order) counters.orderReplies++;
    }
    if (message.type === 'broadcast') {
      counters.broadcasts++;
      if (typeof message.encoded === 'string') counters.encodedBroadcasts++;
    }
  });
}
try {
  const matches = await Promise.all(Array.from({ length: count }, (_, i) => pool.create(`bench-${i}`, {
    roomCode: `bench-${i}`, mode: 'coop', difficulty: 'NORMAL', seed: i + 1, matchNo: 1,
    seats: Array.from({ length: 4 }, (_, seat) => ({
      seat, playerId: `p_${i}_${seat}`, name: `P${seat}`, isBot: false, connected: true,
    })),
  })));
  await Promise.all(matches.map((match) => match.start()));
  const initialization = stop(before);
  const operationCounters = { ...counters }, operationStart = start();
  const latencies = [];
  await Promise.all(matches.map(async (match, i) => {
    for (let j = 0; j < rounds; j++) {
      const at = performance.now();
      await match.handle(`p_${i}_0`, { t: 'b.progress', battleId: 'stale', gt: 0, killed: 0, total: 0 });
      latencies.push(performance.now() - at);
    }
  }));
  const operations = stop(operationStart);
  latencies.sort((a, b) => a - b);
  const percentile = (p) => +latencies[Math.ceil(latencies.length * p) - 1].toFixed(3);
  console.log(JSON.stringify({
    matches: count, lanes, calls: count * rounds, initialization, operations,
    roundTripMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) },
    counters, operationCounters: Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - operationCounters[key]])),
    datasetJsonBytes, datasetTransmissions: counters.configuredDatasets + counters.perMatchDatasets,
    rssBytes: process.memoryUsage().rss,
    scope: 'IPC microbenchmark; process CPU includes all Workers; main ELU is not thread CPU; no capacity claim',
  }, null, 2));
} finally {
  await pool.close();
}
