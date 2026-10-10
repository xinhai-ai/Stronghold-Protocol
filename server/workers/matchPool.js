// Main-thread proxy for complete Match instances hosted in lane Workers.
import { Worker } from 'node:worker_threads';
class RemoteMatch {
  constructor(pool, key, hooks) {
    this.pool = pool;
    this.key = key;
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
  snapshot() { return this.invoke('snapshot'); }
  captureSnapshot() { return this.invoke('capture'); }
  publicView() { return this.public || null; }
  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    return this.invoke('dispose').catch(() => {});
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
  }

  request(message) {
    const requestId = `${this.id}:${++this.nextRequest}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...message, requestId });
    });
  }

  settle(requestId, value, error = null) {
    const item = this.pending.get(requestId);
    if (!item) return;
    this.pending.delete(requestId);
    if (error) item.reject(new Error(error));
    else item.resolve(value);
  }
}

export class MatchWorkerPool {
  constructor({ data, lanes = 1, log = null } = {}) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 32) throw new RangeError('match worker lanes must be 1..32');
    this.data = data;
    this.log = log;
    this.lanes = [];
    this.assignments = new Map();
    this.closed = false;
    for (let i = 0; i < lanes; i++) {
      const worker = new Worker(new URL('./matchWorker.js', import.meta.url), { workerData: undefined });
      const lane = new Lane(i, this, worker);
      worker.on('message', (message) => this.onMessage(lane, message));
      worker.on('error', (error) => this.onWorkerError(lane, error));
      worker.on('exit', (code) => { if (code && !this.closed) this.onWorkerError(lane, new Error(`match worker exited ${code}`)); });
      this.lanes.push(lane);
    }
  }

  laneFor(key) {
    const id = String(key);
    const existing = this.assignments.get(id);
    if (existing != null) return this.lanes[existing];
    const lane = this.lanes.reduce((best, current) => current.matches.size < best.matches.size ? current : best, this.lanes[0]);
    this.assignments.set(id, lane.id);
    return lane;
  }

  create(key, options, hooks = {}, checkpoint = null, departedPlayerIds = []) {
    const id = String(key);
    const lane = this.laneFor(id);
    const match = new RemoteMatch(this, id, hooks);
    match.lane = lane;
    lane.matches.set(id, match);
    return lane.request({ type: 'init', key: id, options: { ...options, data: this.data }, checkpoint, departedPlayerIds })
      .then((meta) => { match.ready = true; match.update(meta); return match; })
      .catch((error) => { lane.matches.delete(id); this.assignments.delete(id); throw error; });
  }

  call(match, method, args) {
    if (this.closed) return Promise.reject(new Error('match worker pool closed'));
    return match.lane.request({ type: 'call', key: match.key, method, args });
  }

  onMessage(lane, message) {
    if (message.type === 'send') {
      const match = lane.matches.get(message.key);
      if (match?.hooks.send) match.hooks.send(message.playerId, message.msg, message.encoded);
    } else if (message.type === 'broadcast') {
      const match = lane.matches.get(message.key);
      if (match) {
        if (message.msg?.t === 'm.public') match.public = message.msg;
        if (message.msg?.t === 'm.result') match.lastResultMsg = message.msg;
        match.hooks.broadcast?.(message.msg);
      }
    } else if (message.type === 'end') {
      const match = lane.matches.get(message.key);
      if (match) { match.update(message.meta); match.hooks.end?.(message.summary); }
    } else if (message.type === 'meta' || message.type === 'ready') {
      const match = lane.matches.get(message.key);
      if (match) match.update(message.meta);
      if (message.requestId) lane.settle(message.requestId, message.meta);
    } else if (message.type === 'result') {
      const match = lane.matches.get(message.key);
      if (match) match.update(message.meta);
      lane.settle(message.requestId, message.value);
    } else if (message.type === 'error') {
      lane.settle(message.requestId, null, message.error);
    }
  }

  onWorkerError(lane, error) {
    this.log?.error?.(`[match-worker:${lane.id}] ${error.message}`);
    for (const item of lane.pending.values()) item.reject(error);
    lane.pending.clear();
  }

  stats() {
    return {
      kind: 'match-workers',
      size: this.lanes.length,
      threads: this.lanes.length,
      busy: this.lanes.filter((lane) => lane.pending.size > 0).length,
      queued: 0,
      rooms: this.lanes.reduce((n, lane) => n + lane.matches.size, 0),
      lanes: this.lanes.map((lane) => ({ id: lane.id, rooms: lane.matches.size, pending: lane.pending.size })),
    };
  }

  release(key) {
    const id = String(key);
    const laneId = this.assignments.get(id);
    if (laneId == null) return;
    this.lanes[laneId]?.matches.delete(id);
    this.assignments.delete(id);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.lanes.map((lane) => new Promise((resolve) => {
      lane.worker.once('exit', resolve);
      lane.worker.postMessage({ type: 'shutdown' });
      setTimeout(() => { lane.worker.terminate().finally(resolve); }, 1000).unref();
    })));
  }
}
