import { Worker } from 'node:worker_threads';

/** Lazy, single dedicated Worker with bounded requests. Failures skip a save; never encode on the game thread. */
export class PersistenceWorker {
  constructor({ timeoutMs = 10_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.seed = null;
    this.stopping = new Set();
  }

  remember(bytes, entries) { this.seed = { bytes, entries }; }

  request(type, payload) {
    if (this.closed) return Promise.reject(new Error('persistence worker closed'));
    if (!this.worker) {
      const worker = new Worker(new URL('./persistence.js', import.meta.url), { workerData: { seed: this.seed } });
      this.worker = worker;
      worker.on('message', ({ id, error, ...value }) => {
        const task = this.pending.get(id);
        if (!task) return;
        this.pending.delete(id);
        clearTimeout(task.timer);
        if (error) task.reject(new Error(error));
        else task.resolve(value);
        if (this.pending.size === 0) worker.unref();
      });
      worker.on('error', (err) => this.drop(worker, err));
      worker.on('exit', (code) => this.drop(worker, new Error(`persistence worker exited (${code})`)));
      worker.unref();
    }
    const worker = this.worker;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.drop(worker, new Error('persistence worker timed out')), this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      try { worker.postMessage({ id, type, payload }); }
      catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
        if (this.pending.size === 0) worker.unref();
      }
    });
  }

  drop(worker, err) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(err); }
    this.pending.clear();
    const stopped = worker.terminate().catch(() => {}).finally(() => this.stopping.delete(stopped));
    this.stopping.add(stopped);
  }

  async close() {
    this.closed = true;
    if (this.worker) this.drop(this.worker, new Error('persistence worker closed'));
    await Promise.all([...this.stopping]);
  }
}
