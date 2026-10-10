// Main-thread proxy for complete Match instances hosted in lane Workers.
import { Worker } from 'node:worker_threads';
class RemoteMatch {
  constructor(pool, key, hooks, instanceId) {
    this.pool = pool;
    this.key = key;
    this.instanceId = instanceId;
    this.remote = true;
    this.hooks = hooks;
    this.pending = new Map();
    this.nextRequest = 0;
    this.queue = Promise.resolve();
    this.ready = false;
    this.disposed = false;
    this.roomCode = key;
    this.order = [];
    this.lastResultMsg = null;
    this._battleSeq = 0;
  }

  update(meta = {}) {
    for (const [key, value] of Object.entries(meta)) this[key] = value;
  }

  invoke(method, ...args) {
    if (this.disposed && method !== 'dispose') return Promise.reject(new Error('match disposed'));
    const run = () => this.pool.call(this, method, args);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  start() { return this.invoke('start'); }
  handle(...args) { return this.invoke('handle', ...args); }
  setLoadout(...args) { return this.invoke('setLoadout', ...args); }
  onDisconnect(...args) { return this.invoke('onDisconnect', ...args); }
  onReconnect(...args) { return this.invoke('onReconnect', ...args); }
  onLeave(...args) { return this.invoke('onLeave', ...args); }
  addSpectator(...args) { return this.invoke('addSpectator', ...args); }
  removeSpectator(...args) { return this.invoke('removeSpectator', ...args); }
  requestSetupReroll(...args) { return this.invoke('requestSetupReroll', ...args); }
  cancelSetupReroll(...args) { return this.invoke('cancelSetupReroll', ...args); }
  snapshot() { return this.invoke('snapshot'); }
  captureSnapshot() { return this.invoke('capture'); }
  publicView() { return this.public || null; }
  dispose() {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = this.invoke('dispose').catch(() => {});
    return this.disposing;
  }
}

class Lane {
  constructor(id, pool, worker) {
    this.id = id;
    this.pool = pool;
    this.worker = worker;
    this.matches = new Map();
    this.pending = new Map();
    this.nextRequest = 0;
    this.closed = false;
    this.failure = null;
    this.exited = false;
  }

  request(message) {
    if (this.closed || this.pool.closed) return Promise.reject(this.failure || new Error('match worker lane closed'));
    const requestId = `${this.id}:${++this.nextRequest}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A command may already have mutated state. Do not continue using an unresponsive lane or retry it.
        this.pool.onWorkerError(this, new Error(`match worker request timed out (${message.type})`));
        this.worker.terminate().catch(() => {});
      }, this.pool.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.worker.postMessage({ ...message, requestId }); }
      catch (error) { this.settle(requestId, null, error); }
    });
  }

  settle(requestId, value, error = null) {
    const item = this.pending.get(requestId);
    if (!item) return;
    this.pending.delete(requestId);
    clearTimeout(item.timer);
    if (error) item.reject(error instanceof Error ? error : new Error(error));
    else item.resolve(value);
  }
}

export class MatchWorkerPool {
  constructor({ data, lanes = 1, log = null, timeoutMs = 120000, workerUrl = new URL('./matchWorker.js', import.meta.url) } = {}) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 32) throw new RangeError('match worker lanes must be 1..32');
    this.data = data;
    this.log = log;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('match worker timeout must be positive');
    this.timeoutMs = timeoutMs;
    this.nextInstance = 0;
    this.lanes = [];
    this.assignments = new Map();
    this.closed = false;
    for (let i = 0; i < lanes; i++) {
      const worker = new Worker(workerUrl, { workerData: undefined });
      const lane = new Lane(i, this, worker);
      worker.on('message', (message) => this.onMessage(lane, message));
      worker.on('error', (error) => this.onWorkerError(lane, error));
      worker.on('exit', (code) => {
        lane.exited = true;
        // Even a clean unexpected exit loses authoritative state.
        if (!this.closed) this.onWorkerError(lane, new Error(`match worker exited ${code}`));
      });
      this.lanes.push(lane);
    }
  }

  laneFor(key) {
    const id = String(key);
    const existing = this.assignments.get(id);
    if (existing != null) return this.lanes[existing];
    const available = this.lanes.filter((lane) => !lane.closed);
    if (!available.length) throw new Error('no healthy match worker lane');
    const lane = available.reduce((best, current) => current.matches.size < best.matches.size ? current : best);
    this.assignments.set(id, lane.id);
    return lane;
  }

  create(key, options, hooks = {}, checkpoint = null, departedPlayerIds = []) {
    if (this.closed) return Promise.reject(new Error('match worker pool closed'));
    const id = String(key);
    let lane;
    try { lane = this.laneFor(id); }
    catch (error) { return Promise.reject(error); }
    if (lane.matches.has(id)) return Promise.reject(new Error(`match already assigned: ${id}`));
    const match = new RemoteMatch(this, id, hooks, ++this.nextInstance);
    match.lane = lane;
    lane.matches.set(id, match);
    const ready = lane.request({ type: 'init', key: id, instanceId: match.instanceId, options: { ...options, data: this.data }, checkpoint, departedPlayerIds })
      .then((meta) => { match.ready = true; match.update(meta); return match; })
      .catch((error) => {
        if (lane.matches.get(id) === match) { lane.matches.delete(id); this.assignments.delete(id); }
        throw error;
      });
    // Reserve ownership synchronously. Lifecycle commands received during init wait for it.
    match.queue = ready.then(() => {}, () => {});
    try { hooks.created?.(match); }
    catch (error) {
      this.release(id, match);
      return ready.then(() => { throw error; }, () => { throw error; });
    }
    return ready;
  }

  call(match, method, args) {
    if (this.closed) return Promise.reject(new Error('match worker pool closed'));
    return match.lane.request({ type: 'call', key: match.key, instanceId: match.instanceId, method, args });
  }

  onMessage(lane, message) {
    if (lane.closed) return;
    const current = lane.matches.get(message.key);
    const match = current?.instanceId === message.instanceId ? current : null;
    if (message.type === 'send') {
      if (match?.hooks.send) match.hooks.send(message.playerId, message.msg, message.encoded);
    } else if (message.type === 'broadcast') {
      if (match) {
        if (message.msg?.t === 'm.public') match.public = message.msg;
        if (message.msg?.t === 'm.result') match.lastResultMsg = message.msg;
        match.hooks.broadcast?.(message.msg);
      }
    } else if (message.type === 'end') {
      if (match) { match.update(message.meta); match.hooks.end?.(message.summary); }
    } else if (message.type === 'meta' || message.type === 'ready') {
      if (match) match.update(message.meta);
      if (message.requestId) lane.settle(message.requestId, message.meta);
    } else if (message.type === 'result') {
      if (match) match.update(message.meta);
      lane.settle(message.requestId, message.value);
    } else if (message.type === 'error') {
      lane.settle(message.requestId, null, message.error);
    }
  }

  onWorkerError(lane, error) {
    if (lane.closed) return;
    lane.closed = true;
    lane.failure = error;
    this.log?.error?.(`[match-worker:${lane.id}] ${error.message}`);
    for (const requestId of [...lane.pending.keys()]) lane.settle(requestId, null, error);
    // Keep proxies and their persistence generations: last safe checkpoints must not be pruned after a crash.
  }

  stats() {
    return {
      kind: 'match-workers',
      size: this.lanes.length,
      threads: this.lanes.filter((lane) => !lane.exited).length,
      failedLanes: this.lanes.filter((lane) => !!lane.failure).length,
      busy: this.lanes.filter((lane) => lane.pending.size > 0).length,
      queued: 0,
      rooms: this.lanes.reduce((n, lane) => n + lane.matches.size, 0),
      lanes: this.lanes.map((lane) => ({ id: lane.id, rooms: lane.matches.size, pending: lane.pending.size, failed: !!lane.failure })),
    };
  }

  release(key, expectedMatch = null) {
    const id = String(key);
    const laneId = this.assignments.get(id);
    if (laneId == null) return;
    const lane = this.lanes[laneId];
    const match = lane?.matches.get(id);
    if (!match || (expectedMatch && expectedMatch !== match)) return;
    // Generation-qualified dispose cannot delete a new match that has already reused this room code.
    match.dispose();
    lane.matches.delete(id);
    this.assignments.delete(id);
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.all(this.lanes.map((lane) => new Promise((resolve) => {
      if (lane.exited) { resolve(); return; }
      for (const requestId of [...lane.pending.keys()]) lane.settle(requestId, null, new Error('match worker pool closed'));
      lane.closed = true;
      const timer = setTimeout(() => { lane.worker.terminate().then(resolve, resolve); }, 1000);
      timer.unref();
      lane.worker.once('exit', () => { clearTimeout(timer); resolve(); });
      try { lane.worker.postMessage({ type: 'shutdown' }); }
      catch { lane.worker.terminate().then(resolve, resolve); }
    }))).then(() => {
      for (const lane of this.lanes) lane.matches.clear();
      this.assignments.clear();
    });
    return this.closing;
  }
}
