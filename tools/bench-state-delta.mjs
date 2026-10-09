// Transport-only benchmark: real four-seat rooms and room.ready routing, synthetic changing PREP views.
// Not a full-match capacity test (no AI/combat, workers, Redis, TLS or deployment).
// node tools/bench-state-delta.mjs --variant full|delta --samples .cache/ws-real-samples.json --sockets 2500 --seconds 20
// Optional affinity: --server-cpus 0,1,2,3,4,5,6,7 --client-cpus 8,9,10,11,12,13,14,15 (requires Python psutil).
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/constants.js';
import { StateReceiver } from '../shared/stateDelta.js';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const variant = arg('variant', 'delta');
const sockets = Number(arg('sockets', 2500)), seconds = Number(arg('seconds', 20)), hz = Number(arg('hz', 1));
const deflateThreshold = Number(arg('deflate-threshold', 1024));
const serverProcess = args.includes('--server');
if (!['full', 'delta'].includes(variant) || !Number.isInteger(sockets) || sockets < 4 || sockets % 4
  || !Number.isInteger(seconds) || seconds < 4 || ![1, 4].includes(hz)
  || !Number.isInteger(deflateThreshold) || deflateThreshold < 0) throw new Error('invalid benchmark options');
const affinity = arg(serverProcess ? 'server-cpus' : 'client-cpus', '');
if (affinity) {
  if (!/^\d+(,\d+)*$/.test(affinity)) throw new Error('invalid CPU list');
  execFileSync('python', ['-c', `import psutil; psutil.Process(${process.pid}).cpu_affinity([${affinity}])`]);
}
const samples = JSON.parse(fs.readFileSync(arg('samples', '.cache/ws-real-samples.json'), 'utf8'));
if (samples.public?.t !== 'm.public' || samples.private?.t !== 'm.private') throw new Error('samples must contain public/private views');
// All benchmark processes run on the same host. Shared monotonic clock avoids cross-process Date.now quantization.
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
const distribution = (values) => {
  values.sort((a, b) => a - b);
  const pct = (p) => values.length ? +values[Math.ceil(values.length * p) - 1].toFixed(2) : null;
  return { count: values.length, p50: pct(.5), p95: pct(.95), p99: pct(.99), max: values.length ? +values.at(-1).toFixed(2) : null };
};

if (serverProcess) {
  const { startServer } = await import('../server/index.js');
  const { sendSession } = await import('../server/net.js');
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null,
    announcementsFile: null, maxRooms: sockets / 4, maxConnections: sockets + 5, wsCompression: true });
  // Test-only override, before any connection negotiates; all other production compression options are unchanged.
  srv.wss.options.perMessageDeflate.threshold = deflateThreshold;
  const views = new Map(), timers = [], connections = new Set();
  let produced = 0, cpuStart, cpuWallStart, wireStart = 0, clientWireStart = 0, frozen = false;
  const compression = { calls: 0, plainBytes: 0, compressedBytes: 0 };
  const wire = { allFrameBytes: 0, controlFrameBytes: 0, errors: 0,
    state: { frames: 0, plainBytes: 0, payloadBytes: 0, headerBytes: 0, frameBytes: 0,
      compressedFrames: 0, compressedPayloadBytes: 0, uncompressedFrames: 0, uncompressedPayloadBytes: 0 },
    other: { frames: 0, plainBytes: 0, payloadBytes: 0, headerBytes: 0, frameBytes: 0,
      compressedFrames: 0, compressedPayloadBytes: 0, uncompressedFrames: 0, uncompressedPayloadBytes: 0 } };
  srv.wss.on('connection', (ws) => {
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    // Test-only ws 8.x framing instrumentation. Observe actual post-deflate buffers, without parsing JSON bodies.
    // Production sends complete unmasked text frames; fail accounting explicitly if that contract changes.
    const messages = [], originalSend = ws.send.bind(ws), sender = ws._sender;
    const originalFrame = sender.sendFrame.bind(sender);
    ws.send = (data, ...rest) => {
      // No new housekeeping frames after the measurement endpoint, so receiver/socket totals use the same boundary.
      if (frozen) return;
      messages.push({ bytes: Buffer.byteLength(data),
        state: typeof data === 'string' && /^\{"t":"m\.(public|private|state)"/.test(data) });
      return originalSend(data, ...rest);
    };
    sender.sendFrame = (list, callback) => {
      const header = list[0], opcode = header[0] & 15;
      const frameBytes = list.reduce((n, part) => n + Buffer.byteLength(part), 0);
      if (cpuStart && !frozen) wire.allFrameBytes += frameBytes;
      if (opcode === 1 || opcode === 2) {
        const meta = messages.shift();
        if (!meta) { if (cpuStart && !frozen) wire.errors++; }
        else if (cpuStart && !frozen) {
          const size = header[1] & 127;
          const headerBytes = 2 + (size === 126 ? 2 : size === 127 ? 8 : 0) + ((header[1] & 128) ? 4 : 0);
          const payloadBytes = size === 126 ? header.readUInt16BE(2) : size === 127 ? Number(header.readBigUInt64BE(2)) : size;
          if (!(header[0] & 128) || (header[1] & 128) || frameBytes !== headerBytes + payloadBytes) wire.errors++;
          const count = meta.state ? wire.state : wire.other;
          count.frames++; count.plainBytes += meta.bytes;
          count.payloadBytes += payloadBytes; count.headerBytes += headerBytes; count.frameBytes += frameBytes;
          if (header[0] & 64) { count.compressedFrames++; count.compressedPayloadBytes += payloadBytes; }
          else { count.uncompressedFrames++; count.uncompressedPayloadBytes += payloadBytes; }
        }
      } else if (cpuStart && !frozen) {
        if (opcode === 0) wire.errors++;
        else wire.controlFrameBytes += frameBytes;
      }
      return originalFrame(list, callback);
    };
    const extension = ws._extensions['permessage-deflate'];
    if (!extension) return;
    const compress = extension.compress.bind(extension);
    extension.compress = (data, fin, callback) => {
      compress(data, fin, (err, body) => {
        if (cpuStart && !frozen && !err) {
          compression.calls++;
          compression.plainBytes += Buffer.byteLength(data);
          compression.compressedBytes += body.length;
        }
        callback(err, body);
      });
    };
  });
  const privateSend = (session, operationRid = null) => {
    const view = views.get(session.playerId);
    view.funds += operationRid === null ? 1 : -1;
    view.benchmarkKind = operationRid === null ? 'background' : 'operation';
    view.benchmarkAt = monotonicMs();
    view.benchmarkSeq++;
    if (operationRid !== null) view.benchmarkOperationRid = operationRid;
    if (!sendSession(session, view)) throw new Error('state send failed');
    if (cpuStart) produced++;
  };
  const original = srv.lobby.onMessage.bind(srv.lobby);
  srv.lobby.onMessage = (session, msg) => {
    const result = original(session, msg);
    if (msg.t === 'room.ready' && !result?.error && views.has(session.playerId)) privateSend(session, msg.rid);
    return result;
  };
  let publicTick = 0;
  const push = (kind) => {
    if (kind === 'public') {
      publicTick++;
      for (const room of srv.lobby.rooms.values()) {
        const players = samples.public.players.map((p, i) => ({ ...p,
          playerId: room.seats[i].playerId, name: room.seats[i].name, ready: room.seats[i].ready }));
        const msg = { ...samples.public, players, benchmarkKind: 'background',
          benchmarkAt: monotonicMs(), benchmarkSeq: publicTick, serverNow: Date.now() };
        srv.lobby.broadcastRoom(room, msg);
        if (cpuStart) produced += 4;
      }
    } else {
      for (const session of srv.registry.all()) if (session.connected) privateSend(session);
    }
  };
  process.send({ port: srv.port });
  process.on('message', async (message) => {
    if (message.prime) {
      for (const session of srv.registry.all()) {
        views.set(session.playerId, { ...structuredClone(samples.private), playerId: session.playerId, benchmarkSeq: 0 });
      }
      push('public'); push('private');
      while (srv.network.bufferedBytes().total) await delay(10);
      process.send({ primed: true });
    } else if (message.start) {
      cpuWallStart = monotonicMs();
      cpuStart = process.cpuUsage();
      wireStart = [...connections].reduce((n, ws) => n + ws._socket.bytesWritten, 0);
      clientWireStart = [...connections].reduce((n, ws) => n + ws._socket.bytesRead, 0);
      for (let i = 1; i <= seconds * hz; i++) {
        timers.push(setTimeout(() => push('public'), Math.max(0, message.startAt + i * 1000 / hz - Date.now())));
      }
      for (let i = 1; i <= seconds * hz / 4; i++) {
        timers.push(setTimeout(() => push('private'), Math.max(0, message.startAt + i * 4000 / hz - Date.now())));
      }
      process.send({ started: true });
    } else if (message.stats || message.finish) {
      if (message.finish) {
        for (const timer of timers) clearTimeout(timer);
        const deadline = monotonicMs() + 10000;
        while (srv.network.bufferedBytes().total && monotonicMs() < deadline) await delay(10);
        frozen = true;
      }
      const cpu = process.cpuUsage(cpuStart);
      const wallMs = monotonicMs() - cpuWallStart, cpuMs = (cpu.user + cpu.system) / 1000;
      const logicalCpus = affinity ? affinity.split(',').length : availableParallelism();
      process.send({ stats: true, produced, compression, rss: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000,
        cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000, totalMs: cpuMs, wallMs, logicalCpus,
          averageCorePercent: cpuMs / wallMs * 100, averageAllocatedPercent: cpuMs / wallMs * 100 / logicalCpus },
        wire,
        wireBytes: [...connections].reduce((n, ws) => n + ws._socket.bytesWritten, 0) - wireStart,
        inboundWireBytes: [...connections].reduce((n, ws) => n + ws._socket.bytesRead, 0) - clientWireStart,
        buffered: srv.network.bufferedBytes(), rooms: srv.lobby.rooms.size });
    } else if (message.close) {
      for (const timer of timers) clearTimeout(timer);
      await srv.close();
      process.disconnect();
    }
  });
} else {
  const child = fork(fileURLToPath(import.meta.url), [...args, '--server'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, UV_THREADPOOL_SIZE: '4' },
  });
  const clients = [], tasks = new Set(), timers = [];
  let collect = false, running = false, issued = 0, failures = 0, orderErrors = 0, decodeErrors = 0;
  let stateFrames = 0, fullFrames = 0, deltaFrames = 0, stateBytes = 0;
  const pingMs = [], operationAckMs = [], operationStateMs = [], backgroundMs = [], errorTypes = {};
  const wait = (predicate, timeout = 60000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('child timeout')); }, timeout);
    const receive = (m) => { if (predicate(m)) { clearTimeout(timer); child.off('message', receive); resolve(m); } };
    child.on('message', receive);
  });
  const command = (message, predicate) => { const result = wait(predicate); child.send(message); return result; };
  try {
    const { port } = await wait((m) => m.port);
    const connect = async (i) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), pending = new Map(), rx = new StateReceiver();
      let rid = 0;
      const client = { ws, id: null, code: null, latest: null, ready: false, busy: false, primed: new Set(),
        request(msg) {
          return new Promise((resolve, reject) => {
            const id = ++rid;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 5000);
            pending.set(id, { resolve, reject, timer, start: performance.now(), operation: msg.t === 'room.ready', stateAt: null });
            ws.send(JSON.stringify({ ...msg, rid: id }));
          });
        } };
      clients.push(client);
      ws.on('error', () => {});
      ws.on('message', (data) => {
        const wire = JSON.parse(data.toString());
        let msg = wire;
        if (wire.t === 'm.state') {
          const decoded = rx.receive(wire);
          if (decoded.resync) decodeErrors++;
          if (!decoded.message) return;
          msg = decoded.message;
        }
        if (msg.t === 'welcome') client.id = msg.playerId;
        if (msg.t === 'room.state') { client.code = msg.code; client.latest = msg; }
        if (msg.t === 'm.public' || msg.t === 'm.private') {
          client.primed.add(msg.t);
          if (collect) {
            stateFrames++; stateBytes += data.length;
            if (wire.patch) deltaFrames++; else fullFrames++;
            if (msg.benchmarkKind === 'background') backgroundMs.push(monotonicMs() - msg.benchmarkAt);
            else if (msg.benchmarkKind === 'operation') {
              const p = pending.get(msg.benchmarkOperationRid);
              if (p) p.stateAt = performance.now() - p.start;
            }
          }
        }
        const p = pending.get(msg.rid);
        if (p) {
          pending.delete(msg.rid); clearTimeout(p.timer);
          if (msg.t === 'error') p.reject(new Error(msg.code));
          else {
            if (collect && p.operation) {
              if (p.stateAt === null) orderErrors++;
              else operationStateMs.push(p.stateAt);
            }
            p.resolve(msg);
          }
        }
      });
      ws.on('close', () => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
        pending.clear();
      });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      await client.request({ t: 'hello', name: 'load' + i, version: PROTOCOL_VERSION, ...(variant === 'delta' ? { stateDelta: 1 } : {}) });
    };
    for (let i = 0; i < sockets; i += 64) await Promise.all(Array.from({ length: Math.min(64, sockets - i) }, (_, j) => connect(i + j)));
    for (let i = 0; i < sockets; i += 128) {
      await Promise.all(Array.from({ length: Math.ceil(Math.min(128, sockets - i) / 4) }, async (_, g) => {
        const group = clients.slice(i + g * 4, i + g * 4 + 4);
        await group[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
        for (const guest of group.slice(1)) await guest.request({ t: 'room.join', code: group[0].code });
      }));
    }
    await command({ prime: true }, (m) => m.primed);
    const primeDeadline = Date.now() + 10000;
    while (clients.some((c) => c.primed.size !== 2)) {
      if (Date.now() >= primeDeadline) throw new Error('prime timeout');
      await delay(20);
    }
    for (const c of clients) c.rawStart = c.ws._socket.bytesRead;
    collect = true;
    const startAt = Date.now() + 200;
    await command({ start: true, startAt }, (m) => m.started);
    await delay(Math.max(0, startAt - Date.now()));
    running = true;
    const start = performance.now();
    const probe = async (c) => {
      issued++;
      try {
        const pingAt = performance.now();
        await c.request({ t: 'ping', c: Date.now() });
        pingMs.push(performance.now() - pingAt);
        c.ready = !c.ready;
        const opAt = performance.now();
        await c.request({ t: 'room.ready', ready: c.ready });
        operationAckMs.push(performance.now() - opAt);
        if (c.latest.seats.find((p) => p?.playerId === c.id)?.ready !== c.ready) orderErrors++;
      } catch (e) { failures++; errorTypes[e.message] = (errorTypes[e.message] || 0) + 1; }
    };
    clients.forEach((c, i) => {
      const tick = () => {
        if (!running || c.busy) return;
        c.busy = true;
        const task = probe(c).finally(() => { c.busy = false; tasks.delete(task); });
        tasks.add(task);
      };
      timers.push(setTimeout(() => { tick(); timers.push(setInterval(tick, 4000)); }, i * 4000 / sockets));
    });
    await delay(seconds * 1000 + 100);
    running = false;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    await Promise.allSettled([...tasks]);
    let stats;
    const drainDeadline = Date.now() + 10000;
    do {
      await delay(100);
      stats = await command({ stats: true }, (m) => m.stats);
    } while (stateFrames < stats.produced && Date.now() < drainDeadline);
    stats = await command({ finish: true }, (m) => m.stats);
    const receiveDeadline = Date.now() + 5000;
    while (clients.reduce((n, c) => n + c.ws._socket.bytesRead - c.rawStart, 0) < stats.wireBytes && Date.now() < receiveDeadline) {
      await delay(10);
    }
    const receivedWireBytes = clients.reduce((n, c) => n + c.ws._socket.bytesRead - c.rawStart, 0);
    const accounting = {
      stateFramesMatch: stateFrames === stats.produced && stateFrames === stats.wire.state.frames,
      statePlainBytesMatch: stateBytes === stats.wire.state.plainBytes,
      frameSocketBytesMatch: stats.wire.allFrameBytes === stats.wireBytes,
      sentReceivedBytesMatch: stats.wireBytes === receivedWireBytes,
      partitionsMatch: stats.wire.allFrameBytes === stats.wire.state.frameBytes + stats.wire.other.frameBytes + stats.wire.controlFrameBytes,
      compressionPayloadMatch: stats.compression.compressedBytes === stats.wire.state.compressedPayloadBytes + stats.wire.other.compressedPayloadBytes,
      compressionCallsMatch: stats.compression.calls === stats.wire.state.compressedFrames + stats.wire.other.compressedFrames,
      noFrameErrors: stats.wire.errors === 0,
    };
    if (Object.values(accounting).some((ok) => !ok)) process.exitCode = 1;
    console.log(JSON.stringify({ variant, node: process.version, sockets, rooms: sockets / 4, seconds, hz, deflateThreshold,
      serverCpus: arg('server-cpus', null), clientCpus: arg('client-cpus', null), uvThreads: 4, backgroundClock: 'host-monotonic',
      elapsedSec: (performance.now() - start) / 1000, issued, failures, errorTypes, orderErrors, decodeErrors,
      pingMs: distribution(pingMs), operationAckMs: distribution(operationAckMs), operationStateMs: distribution(operationStateMs),
      backgroundMs: distribution(backgroundMs), stateFrames, fullFrames, deltaFrames, stateBytes, receivedWireBytes, accounting, server: stats }, null, 2));
  } finally {
    running = false;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    for (const c of clients) c.ws.terminate();
    if (child.connected) child.send({ close: true });
    const timer = setTimeout(() => child.kill(), 10000);
    await new Promise((resolve) => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    clearTimeout(timer);
  }
}
