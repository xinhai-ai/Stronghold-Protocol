// Local retained-memory probes. Run with --expose-gc; only the MAIN heap is explicitly collected.
// Worker samples include their normal post-task garbage; this is not an online capacity benchmark.
import { SimulationPool } from '../server/workers/pool.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { DATA, makeMatch } from '../test/match/harness.js';

const mib = (n) => +(n / 1024 / 1024).toFixed(2);
function report(label, pool = null) {
  global.gc?.();
  const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
  console.log(JSON.stringify({ label, rssMiB: mib(rss), mainHeapUsedMiB: mib(heapUsed), mainHeapTotalMiB: mib(heapTotal),
    mainExternalMiB: mib(external), workerHeapSamplesMiB: pool ? pool.stats().memory.map(({ sample }) => sample ? mib(sample.heapUsed) : null) : [] }));
}
report('data and engine loaded');
const registry = new SessionRegistry();
const lobby = new Lobby({ registry, getData: () => DATA });
for (let i = 0; i < 276; i++) {
  const s = registry.create('benchmark');
  s.connected = true;
  lobby.create(s, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.startMatch(lobby.getRoom(s.roomCode));
}
report('276 real room matches at INFO_CHECK');
lobby.shutdown();
report('rooms disposed, reconnect sessions retained');

const h = makeMatch({ humans: 2, seed: 9112, clientCombat: true, clients: false });
h.start();
h.drive(() => h.m.phase === 'COMBAT');
const field = h.m.fields[0];
const pool = new SimulationPool({ data: DATA, size: 8 });
try {
  for (const count of [1, 4, 8]) {
    await Promise.all(Array.from({ length: count }, () => pool.submit('battle', { spec: field.spec, players: field.players }).promise));
    report(count + ' simulation workers after real battle work', pool);
  }
} finally {
  await pool.close();
  h.m.dispose();
}
report('all workers closed');
