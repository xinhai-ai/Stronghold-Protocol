// Room-pinned simulation lanes.
//
// The WebSocket and Match object remain on the main thread in this first phase. A room's battle/rehearsal work is
// pinned to one lane instead of contending in one global simulation queue.
import { SimulationPool } from './pool.js';

export class RoomWorkerPool {
  constructor({ data, lanes = 1, totalWorkers = 1, maxQueue = 256, timeoutMs = 120000 } = {}) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 32) throw new RangeError('room worker lanes must be 1..32');
    if (!Number.isInteger(totalWorkers) || totalWorkers < lanes || totalWorkers > 32) {
      throw new RangeError('room worker total must be between lanes and 32');
    }
    this.lanes = Array.from({ length: lanes }, (_, i) => ({
      id: i,
      rooms: new Set(),
      pool: new SimulationPool({
        data,
        size: Math.max(1, Math.ceil((totalWorkers - i) / lanes)),
        maxQueue,
        timeoutMs,
      }),
    }));
    this.assignments = new Map();
    this.closed = false;
  }

  /** Pin a room or standalone match key to the least-loaded lane. */
  assign(key) {
    const id = String(key || '');
    const existing = this.assignments.get(id);
    if (existing != null) return this.lanes[existing].pool;
    const lane = this.lanes.reduce((best, current) => current.rooms.size < best.rooms.size ? current : best, this.lanes[0]);
    lane.rooms.add(id);
    this.assignments.set(id, lane.id);
    return lane.pool;
  }

  release(key) {
    const id = String(key || '');
    const laneId = this.assignments.get(id);
    if (laneId == null) return;
    this.assignments.delete(id);
    this.lanes[laneId]?.rooms.delete(id);
  }

  stats() {
    const lanes = this.lanes.map((lane) => ({ id: lane.id, rooms: lane.rooms.size, ...lane.pool.stats() }));
    const sum = (field) => lanes.reduce((n, item) => n + (Number(item[field]) || 0), 0);
    return {
      kind: 'room-lanes',
      size: sum('size'), threads: sum('threads'), busy: sum('busy'), queued: sum('queued'),
      maxQueue: sum('maxQueue'), timeoutMs: Math.max(...lanes.map((s) => s.timeoutMs)),
      submitted: sum('submitted'), completed: sum('completed'), failed: sum('failed'),
      cancelled: sum('cancelled'), rejected: sum('rejected'), queueMs: sum('queueMs'), computeMs: sum('computeMs'),
      avgComputeMs: sum('completed') ? sum('computeMs') / sum('completed') : 0,
      lanes,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.lanes.map((lane) => lane.pool.close()));
  }
}
