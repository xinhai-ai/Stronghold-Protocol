// Focused microbenchmarks, not player capacity: unchanged resource checks, forced public state over IPC to fake
// four-seat sockets, and INFO_CHECK captures saved to an in-memory sink. No Redis/WS/TLS/browser/combat load.
// node tools/server-hotpathsbench.mjs --matches 32 --lanes 2 --rounds 20 --checks 50
import { performance } from 'node:perf_hooks';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getData } from '../server/data.js';
import { Persister } from '../server/persist.js';
import { send } from '../server/net.js';
import { negotiateStateDelta } from '../server/stateTransport.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? fallback : args[i + 1];
};
const count = Number(arg('matches', 32)), lanes = Number(arg('lanes', 2)), rounds = Number(arg('rounds', 20));
const checks = Number(arg('checks', 50));
if (![count, lanes, rounds, checks].every(Number.isInteger) || count < 1 || count > 256 || lanes < 1 || lanes > 32
  || rounds < 1 || rounds > 1000 || checks < 1 || checks > 1000) throw new Error('invalid benchmark options');
const moduleUrl = (option, fallback) => arg(option, '') ? pathToFileURL(path.resolve(arg(option))).href : fallback;
const { createResourceIndex } = await import(moduleUrl('resource-module', '../server/resources.js'));
const { MatchWorkerPool } = await import(moduleUrl('pool-module', '../server/workers/matchPool.js'));
const data = getData({ log: { info() {}, warn() {}, error() {} } });
const start = () => ({ wall: performance.now(), cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() });
const stop = (before) => {
  const cpu = process.cpuUsage(before.cpu), elu = performance.eventLoopUtilization(before.elu);
  return { wallMs: +(performance.now() - before.wall).toFixed(2),
    processCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2), mainEventLoopActiveMs: +elu.active.toFixed(2) };
};
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-hotpathsbench-'));
const root = path.resolve(dir);
if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('temporary directory outside expected root');
const results = { matches: count, lanes, rounds, checks };
let pool, persister;
try {
  await fsp.writeFile(path.join(dir, 'assets.json'), JSON.stringify(data.assets));
  const index = createResourceIndex({ dataDir: dir, publicDir: dir, readFile: (...args) => fsp.readFile(...args) });
  await index.get();
  const readFile = fsp.readFile;
  let reads = 0;
  fsp.readFile = (...args) => { reads++; return readFile(...args); };
  let before = start();
  try { for (let i = 0; i < checks; i++) await index.get(); }
  finally { fsp.readFile = readFile; }
  results.resourceChecks = { ...stop(before), bodyReads: reads };

  const counters = { frameObjects: 0, encodedOnlyFrames: 0, rawCapturePosts: 0, transferredCapturePosts: 0 };
  pool = new MatchWorkerPool({ data, lanes });
  for (const lane of pool.lanes) lane.worker.on('message', (message) => {
    if (message.type !== 'send' && message.type !== 'broadcast') return;
    if (message.msg) counters.frameObjects++;
    else if (message.kind && typeof message.encoded === 'string') counters.encodedOnlyFrames++;
  });
  let wireFrames = 0, wireBytes = 0;
  const sockets = Array.from({ length: count }, () => Array.from({ length: 4 }, () => {
    const ws = { readyState: 1, bufferedAmount: 0, send(bytes) { wireFrames++; wireBytes += Buffer.byteLength(bytes); } };
    negotiateStateDelta(ws, 1);
    return ws;
  }));
  const matches = await Promise.all(sockets.map((peers, i) => pool.create(`bench-${i}`, {
    roomCode: `bench-${i}`, mode: 'coop', difficulty: 'NORMAL', seed: i + 1, matchNo: 1,
    seats: peers.map((_, seat) => ({ seat, playerId: `p_${i}_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
  }, {
    broadcast(msg, encoded) { for (const ws of peers) send(ws, msg, encoded); },
    send(playerId, msg, encoded) { const seat = Number(playerId.split('_').at(-1)); send(peers[seat], msg, encoded); },
  })));
  await Promise.all(matches.map((match) => match.start()));
  counters.frameObjects = counters.encodedOnlyFrames = wireFrames = wireBytes = 0;
  before = start();
  for (let i = 0; i < rounds; i++) await Promise.all(matches.map((match) => match.invoke('flush', true)));
  results.stateForwarding = { ...stop(before), frameObjects: counters.frameObjects,
    encodedOnlyFrames: counters.encodedOnlyFrames, wireFrames, wireBytes };

  persister = new Persister({ registry: { all: () => [] },
    lobby: { rooms: new Map(), persistenceMatches: () => matches.map((match, i) => ({ key: `bench-${i}`, match })) },
    store: { async saveSerialized() { return true; } } });
  await persister.flush('warmup');
  const request = persister.encoder.request.bind(persister.encoder);
  let postMs = 0;
  persister.encoder.request = (type, payload, transfer) => {
    if (type === 'checkpoint') counters.rawCapturePosts++;
    else if (type === 'checkpointBytes') counters.transferredCapturePosts++;
    const at = performance.now();
    const promise = request(type, payload, transfer);
    postMs += performance.now() - at;
    return promise;
  };
  before = start();
  for (let i = 0; i < 3; i++) if (!await persister.flush('bench')) throw new Error('save failed');
  results.persistence = { ...stop(before), saves: 3, rawCapturePosts: counters.rawCapturePosts,
    transferredCapturePosts: counters.transferredCapturePosts, encoderPostMs: +postMs.toFixed(2) };
  results.rssBytes = process.memoryUsage().rss;
  results.scope = 'microbenchmarks only; process CPU includes Workers; ELU active is not main-thread CPU';
  console.log(JSON.stringify(results, null, 2));
} finally {
  await persister?.encoder.close();
  await pool?.close();
  await fsp.rm(dir, { recursive: true, force: true });
}
