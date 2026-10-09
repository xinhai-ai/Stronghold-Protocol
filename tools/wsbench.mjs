#!/usr/bin/env node
// Local WS benchmark: server and clients use separate processes. Real lobby
// rooms/ready requests, staggered ping probes, optional synthetic global pushes.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/constants.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? fallback : args[i + 1];
};
const integer = (name, fallback, min, max) => {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be ${min}..${max}`);
  return value;
};
const sockets = integer('sockets', 2500, 4, 10000);
const seconds = integer('seconds', 12, 4, 120);
const intervalMs = integer('interval-ms', 4000, 500, 60000);
const pushBytes = integer('push-bytes', 0, 0, 65536);
const compression = option('compression', 'off');
if (!['on', 'off'].includes(compression)) throw new Error('--compression must be on|off');

if (args.includes('--server')) {
  const { startServer } = await import('../server/index.js');
  const server = await startServer({ port: 0, host: '127.0.0.1', workers: 0, store: null, quiet: true,
    announcementsFile: null, maxConnections: sockets + 10, maxRooms: sockets,
    wsCompression: compression === 'on' });
  if (args.includes('--legacy-fanout')) {
    server.network._eachConnection = (fn, kind) => {
      for (const conn of server.network.conns.values()) fn(conn);
      if (kind === 'heartbeat') server.network._heartbeatPending = false;
    };
  }
  // Only stress mode generates synthetic game-sized frames. This is not battle simulation.
  let push = null;
  process.send({ port: server.port });
  let stopping = false;
  process.on('message', async (message) => {
    if (message.measure) {
      if (pushBytes && !push) push = setInterval(() => server.network.broadcast({ t: 'bench.state', payload: 'x'.repeat(pushBytes) }), 250);
      return;
    }
    if (stopping) return;
    stopping = true;
    if (push) clearInterval(push);
    process.send({ diagnostics: server.network.diagnostics.stats(), buffers: server.network.bufferedBytes() });
    await server.close();
    process.disconnect();
  });
  process.on('disconnect', () => { server.close().catch(() => {}); });
} else {
  const child = fork(fileURLToPath(import.meta.url), [...args, '--server'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const clients = [];
  const timers = new Set();
  const pendingProbes = new Set();
  let running = true;
  let errors = 0;
  const pingMs = [], operationMs = [];
  const round = (value) => +value.toFixed(2);
  const distribution = (values) => {
    values.sort((a, b) => a - b);
    const percentile = (p) => values.length ? round(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]) : 0;
    return { samples: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
      maxMs: values.length ? round(values.at(-1)) : 0 };
  };
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`benchmark server exited (${code})`)));
  });
  async function connect(url, id) {
    const ws = new WebSocket(url, { perMessageDeflate: compression === 'on' });
    const requests = new Map();
    let rid = 0;
    const fail = (err) => { for (const request of requests.values()) request.reject(err); requests.clear(); };
    ws.on('error', fail);
    ws.on('close', () => fail(new Error('socket closed')));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'room.state') client.code = msg.code;
      const request = requests.get(msg.rid);
      if (!request) return;
      requests.delete(msg.rid);
      clearTimeout(request.timer);
      if (msg.t === 'error') request.reject(new Error(msg.code));
      else request.resolve(msg);
    });
    const client = { ws, request(msg) {
      return new Promise((resolve, reject) => {
        const key = ++rid;
        const timer = setTimeout(() => { requests.delete(key); reject(new Error('reply timeout')); }, 10000);
        requests.set(key, { resolve, reject: (err) => { clearTimeout(timer); reject(err); }, timer });
        ws.send(JSON.stringify({ ...msg, rid: key }));
      });
    } };
    clients.push(client);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('connect timeout')); }, 10000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    await client.request({ t: 'hello', name: 'bench' + id, version: PROTOCOL_VERSION });
    return client;
  }
  try {
    const { port } = await ready;
    for (let i = 0; i < sockets; i += 64) {
      await Promise.all(Array.from({ length: Math.min(64, sockets - i) }, (_, j) => connect(`ws://127.0.0.1:${port}/ws`, i + j)));
    }
    const groups = Array.from({ length: Math.ceil(clients.length / 4) }, (_, i) => clients.slice(i * 4, i * 4 + 4));
    for (let i = 0; i < groups.length; i += 32) {
      await Promise.all(groups.slice(i, i + 32).map(async (group) => {
        await group[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
        if (!group[0].code) throw new Error('room.state missing before create acknowledgment');
        for (const guest of group.slice(1)) await guest.request({ t: 'room.join', code: group[0].code });
      }));
    }
    await delay(1000);
    child.send({ measure: true });
    const probe = async (client) => {
      try {
        const start = performance.now();
        await client.request({ t: 'ping', c: Date.now() });
        if (pingMs.length < 100000) pingMs.push(performance.now() - start);
        const operationStart = performance.now();
        client.ready = !client.ready;
        await client.request({ t: 'room.ready', ready: client.ready });
        if (operationMs.length < 100000) operationMs.push(performance.now() - operationStart);
      } catch { errors++; }
    };
    clients.forEach((client, i) => {
      let busy = false;
      const tick = () => {
        if (!running || busy) return;
        busy = true;
        const task = probe(client).finally(() => { busy = false; pendingProbes.delete(task); });
        pendingProbes.add(task);
      };
      const initial = setTimeout(() => {
        timers.delete(initial);
        if (!running) return;
        tick();
        timers.add(setInterval(tick, intervalMs));
      }, Math.floor(i * intervalMs / clients.length));
      timers.add(initial);
    });
    await delay(seconds * 1000);
    running = false;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    timers.clear();
    await Promise.allSettled([...pendingProbes]);
    const serverMetrics = new Promise((resolve, reject) => {
      const finish = (err, value) => {
        clearTimeout(timer);
        child.off('message', received);
        child.off('exit', exited);
        if (err) reject(err);
        else resolve(value);
      };
      const received = (value) => finish(null, value);
      const exited = (code) => finish(new Error(`benchmark server exited before metrics (${code})`));
      const timer = setTimeout(() => finish(new Error('benchmark metrics timeout')), 10000);
      child.once('message', received);
      child.once('exit', exited);
    });
    child.send({ stop: true });
    const metrics = await serverMetrics;
    console.log(JSON.stringify({ node: process.version, sockets: clients.length, rooms: groups.length,
      seconds, intervalMs, compression, pushBytes, legacyFanout: args.includes('--legacy-fanout'), errors,
      ping: distribution(pingMs), operation: distribution(operationMs), ...metrics }, null, 2));
    if (errors) process.exitCode = 1;
  } finally {
    running = false;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    await Promise.allSettled([...pendingProbes]);
    for (const client of clients) client.ws.terminate();
    if (child.connected) child.send({ stop: true });
    if (child.exitCode === null && child.signalCode === null) {
      const stopping = new Promise((resolve) => child.once('exit', resolve));
      const deadline = setTimeout(() => child.kill(), 10000);
      await stopping;
      clearTimeout(deadline);
    }
  }
}
