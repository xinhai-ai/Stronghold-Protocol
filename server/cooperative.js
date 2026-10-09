// FIFO work shared by all real matches. A new setImmediate turn lets socket I/O run
// between CPU slices; the budget includes the callbacks' state flushes.
export class CooperativeQueue {
  constructor({ budgetMs = 4, maxTasks = 64, now = () => performance.now(),
    schedule = (fn) => setImmediate(fn), cancel = (h) => clearImmediate(h) } = {}) {
    this.budgetMs = budgetMs;
    this.maxTasks = maxTasks;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.tasks = new Map();
    this.handle = null;
    this.running = false;
  }

  enqueue(fn) {
    const token = {};
    this.tasks.set(token, fn);
    this._schedule();
    return token;
  }

  remove(token) {
    this.tasks.delete(token);
    if (!this.tasks.size && this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
  }

  _schedule() {
    if (this.running || this.handle !== null || !this.tasks.size) return;
    this.handle = this.schedule(() => this._pump());
    this.handle?.unref?.();
  }

  _pump() {
    this.handle = null;
    this.running = true;
    const deadline = this.now() + this.budgetMs;
    try {
      for (let n = 0; this.tasks.size && n < this.maxTasks; n++) {
        const token = this.tasks.keys().next().value;
        const fn = this.tasks.get(token);
        this.tasks.delete(token);
        fn();
        if (this.now() >= deadline) break;
      }
    } finally {
      this.running = false;
      this._schedule();
    }
  }
}

export const matchWorkQueue = new CooperativeQueue();
