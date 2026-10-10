import { parentPort } from 'node:worker_threads';

// Initialize normally, but never acknowledge commands (tests exercise the parent's timeout/close paths).
parentPort?.on('message', (message) => {
  if (message.type === 'configure') {
    if (message.data?.hangConfigure) return;
    parentPort.postMessage({ type: 'configured', requestId: message.requestId });
  } else if (message.type === 'init') {
    parentPort.postMessage({ type: 'ready', key: message.key, instanceId: message.instanceId,
      requestId: message.requestId, meta: { roomCode: message.key, order: [] } });
  } else if (message.type === 'shutdown') process.exit(0);
});
