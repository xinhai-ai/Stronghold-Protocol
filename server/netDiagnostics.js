import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Bounded histograms: no per-player data, frame contents, or growing sample arrays.
const BOUNDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024,
  2048, 4096, 8192, 16384, 32768, 65536, Infinity];
export class TimingHistogram {
  constructor() { this.count = 0; this.totalMs = 0; this.maxMs = 0; this.buckets = new Float64Array(BOUNDS.length); }
  record(ms) {
    this.count++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    this.buckets[BOUNDS.findIndex((bound) => ms <= bound)]++;
  }
  stats() {
    const percentile = (p) => {
      if (!this.count) return 0;
      let n = 0;
      for (let i = 0; i < BOUNDS.length; i++) {
        n += this.buckets[i];
        if (n >= Math.ceil(this.count * p)) return Math.min(BOUNDS[i], this.maxMs);
      }
      return this.maxMs;
    };
    return { count: this.count, avgMs: this.count ? this.totalMs / this.count : 0,
      maxMs: this.maxMs, p95UpperMs: percentile(0.95), p99UpperMs: percentile(0.99) };
  }
}

export class NetDiagnostics {
  constructor() {
    this.startedAt = performance.now();
    this.eluStart = performance.eventLoopUtilization();
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.receivedFrames = 0;
    this.receivedBytes = 0;
    this.handlers = new Map();
    this.sendCompletion = new TimingHistogram();
    this.sentFrames = 0;
    this.sentBytes = 0;
    this.droppedSnapshots = 0;
    this.slowDisconnects = 0;
  }
  received(type, bytes, elapsedMs) {
    this.receivedFrames++;
    this.receivedBytes += bytes;
    if (!this.handlers.has(type)) this.handlers.set(type, new TimingHistogram());
    this.handlers.get(type).record(elapsedMs);
  }
  sent(data) {
    this.sentFrames++;
    this.sentBytes += Buffer.byteLength(data);
    // Sample callbacks to keep the hot send path cheap. This is local completion,
    // including compression/TCP queuing, not delivery or client RTT.
    if (this.sentFrames % 64) return null;
    const start = performance.now();
    return (err) => { if (!err) this.sendCompletion.record(performance.now() - start); };
  }
  stats() {
    const ms = (value) => Number.isFinite(value) ? value / 1e6 : 0;
    return { period: 'sinceStart', elapsedSec: (performance.now() - this.startedAt) / 1000,
      eventLoop: { resolutionMs: 20, utilization: performance.eventLoopUtilization(this.eluStart).utilization,
        meanMs: this.loop.count ? ms(this.loop.mean) : 0, maxMs: this.loop.count ? ms(this.loop.max) : 0,
        p95Ms: this.loop.count ? ms(this.loop.percentile(95)) : 0, p99Ms: this.loop.count ? ms(this.loop.percentile(99)) : 0 },
      receivedFrames: this.receivedFrames, receivedBytes: this.receivedBytes,
      sentFrames: this.sentFrames, sentBytes: this.sentBytes,
      droppedSnapshots: this.droppedSnapshots, slowDisconnects: this.slowDisconnects,
      handlerMs: Object.fromEntries([...this.handlers].map(([type, timing]) => [type, timing.stats()])),
      sendCompletionMs: { sampleEvery: 64, ...this.sendCompletion.stats() } };
  }
  close() { this.loop.disable(); }
}

export const socketDiagnostics = new WeakMap();
