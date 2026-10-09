#!/usr/bin/env node
// CPU benchmark of the production health body builders. No HTTP/TLS traffic:
// the synthetic room topology is scanned by the real Lobby.stats implementation.
import { performance } from 'node:perf_hooks';
import { Lobby } from '../server/lobby.js';
import { createHealthBody, healthReport } from '../server/http/routes.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf('--' + name);
  const value = Number(i < 0 ? fallback : args[i + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const rooms = option('rooms', 625);
const reads = option('reads', 100000);
if (rooms > 10000 || reads > 1000000) throw new Error('--rooms must be <= 10000 and --reads <= 1000000');
const lobby = Object.assign(Object.create(Lobby.prototype), {
  rooms: new Map(Array.from({ length: rooms }, (_, i) => [String(i), {
    match: i % 2 ? {} : null,
    seats: Array.from({ length: 4 }, (_, j) => ({ isBot: j === 3, left: false })),
    spectators: [],
  }])),
  activeQueueMatches: new Set(), queueByPlayer: new Map(),
});
let scans = 0;
const stats = lobby.stats.bind(lobby);
lobby.stats = () => { scans++; return stats(); };
const health = { startedAt: Date.now(), lobby, network: { connectionCount: rooms * 4 }, registry: { size: rooms * 4 } };
// Exclude module loading/build-tag lookup from both timings.
healthReport(health);
const measure = (read) => {
  scans = 0;
  let bytes = 0;
  const start = performance.now();
  for (let i = 0; i < reads; i++) bytes += read().length;
  const elapsedMs = performance.now() - start;
  return { reads, elapsedMs: +elapsedMs.toFixed(2), scans,
    readsPerSecond: Math.round(reads * 1000 / elapsedMs), bytes };
};
const baseline = measure(() => Buffer.from(JSON.stringify(healthReport(health))));
const read = createHealthBody(health);
const cached = measure(read);
const { uptimeSec: _cachedUptime, ...cachedReport } = JSON.parse(read());
const { uptimeSec: _freshUptime, ...freshReport } = healthReport(health);
const identicalCounters = JSON.stringify(cachedReport) === JSON.stringify(freshReport);
console.log(JSON.stringify({ node: process.version, rooms, identicalCounters, baseline, cached }, null, 2));
if (!identicalCounters) process.exitCode = 1;
