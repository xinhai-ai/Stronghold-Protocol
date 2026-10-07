// Dedicated to persistence so a save never waits behind battle simulation or AI rehearsal.
import { parentPort, workerData } from 'node:worker_threads';
import { encodeMatchCapture } from '../match/snapshot.js';
import { memorySample } from './memory.js';

const checkpoints = new Map();
function seed(doc, entries) {
  for (const { key, generation } of entries) {
    const checkpoint = doc.matches?.[key];
    if (checkpoint) checkpoints.set(key, { generation, checkpoint });
  }
}
if (workerData?.seed) {
  const { doc, bytes, entries } = workerData.seed;
  seed(doc || JSON.parse(new TextDecoder().decode(bytes)), entries);
}

parentPort.on('message', ({ id, type, payload }) => {
  try {
    if (type === 'seed') {
      seed(payload.doc, payload.entries);
      const bytes = new TextEncoder().encode(JSON.stringify(payload.doc));
      parentPort.postMessage({ id, bytes, memory: memorySample() }, [bytes.buffer]);
    } else if (type === 'checkpoint') {
      const checkpoint = encodeMatchCapture(payload.capture);
      if (!checkpoint) throw new Error('match checkpoint could not be encoded');
      checkpoints.set(payload.key, { generation: payload.generation, checkpoint });
      parentPort.postMessage({ id, memory: memorySample() });
    } else if (type === 'serialize') {
      const active = new Map(payload.entries.map(({ key, generation }) => [key, generation]));
      const matches = {};
      for (const [key, entry] of checkpoints) {
        if (active.get(key) !== entry.generation) { checkpoints.delete(key); continue; }
        matches[key] = entry.checkpoint;
      }
      const bytes = new TextEncoder().encode(JSON.stringify({ ...payload.doc, matches }));
      parentPort.postMessage({ id, bytes, keys: Object.keys(matches), memory: memorySample() }, [bytes.buffer]);
    } else throw new Error(`unknown persistence task: ${type}`);
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
