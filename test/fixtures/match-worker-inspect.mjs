// Exercise the production Worker, with test-only probes installed AFTER it configures the owning data snapshot.
import { parentPort } from 'node:worker_threads';

if (parentPort) {
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (message, ...args) => {
    if (message.type === 'configured') {
      install().then(() => post(message, ...args)).catch((error) => {
        post({ type: 'error', requestId: message.requestId, error: error.message });
      });
      return;
    }
    return post(message, ...args);
  };
  await import('../../server/workers/matchWorker.js');
}

async function install() {
  const [{ Match }, { getData }, { getSimData }, { gameData }] = await Promise.all([
    import('../../server/match/Match.js'), import('../../server/data.js'),
    import('../../server/sim/simdata.js'), import('../../server/sim/content/support/index.js'),
  ]);
  let first;
  Match.prototype.inspectWorkerData = function () {
    first ||= this.data;
    return {
      shared: this.data === first && this.opts.data === first && this.gd.raw === first,
      frozen: Object.isFrozen(this.data) && Object.isFrozen(this.data.config),
      singleton: this.data === getData(),
      sim: this.data === getSimData(),
      content: this.data === gameData(),
      marker: this.data.workerTestMarker,
    };
  };
  Match.prototype.inspectMetadataCloneFailure = function () {
    this._battleSeq++;
    return () => {};
  };
  Match.prototype.inspectFixedClock = function (now) {
    this.sched._now = () => now;
  };
  Match.prototype.inspectInvalidCapture = function (invalid) {
    if (invalid) this.order[0].hand.push(() => {});
    else this.order[0].hand.pop();
  };
  Match.prototype.inspectCapturePhase = function (phase) {
    this.phase = phase;
  };
}
