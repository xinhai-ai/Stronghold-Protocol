// Connection-local baselines. Snapshot and diff encoding are shared only for the SAME message/baseline objects,
// never across players' private views. Weak maps release disconnected sockets and superseded snapshots.
import { diffState, isStateKind, STATE_DELTA_VERSION } from '../shared/stateDelta.js';

const connections = new WeakMap();
const snapshots = new WeakMap();
let sequence = 0;

export function negotiateStateDelta(ws, version) {
  const enabled = version === STATE_DELTA_VERSION;
  const old = connections.get(ws);
  if (enabled && old) return; // repeated hello is coalesced by the lobby; do not invalidate queued deltas early
  if (enabled) connections.set(ws, new Map());
  else connections.delete(ws);
}

export function resetStateDelta(ws) { connections.get(ws)?.clear(); }

/** Return an encoded state and commit its baseline ONLY after the caller successfully queues the reliable frame. */
export function prepareStateFrame(ws, msg, encoded) {
  const states = connections.get(ws);
  if (!states || !isStateKind(msg?.t)) return { data: encoded, commit() {} };
  let snapshot = snapshots.get(msg);
  // The encoding, not mutable game objects, owns this immutable baseline.
  if (!snapshot || snapshot.encoded !== encoded) {
    const seq = ++sequence;
    snapshot = {
      encoded, seq, view: JSON.parse(encoded), transitions: new WeakMap(),
      full: `{"t":"m.state","kind":${JSON.stringify(msg.t)},"seq":${seq},"full":${encoded}}`,
    };
    snapshots.set(msg, snapshot);
  }
  const previous = states.get(msg.t);
  let data = snapshot.full;
  if (previous && previous !== snapshot) {
    let transition = snapshot.transitions.get(previous);
    if (transition === undefined) {
      const patch = diffState(previous.view, snapshot.view);
      const delta = patch && JSON.stringify({ t: 'm.state', kind: msg.t, seq: snapshot.seq, base: previous.seq, patch });
      // Compare actual UTF-8 bytes, not JS string length. Large changes fall back to full.
      transition = delta && Buffer.byteLength(delta) < Buffer.byteLength(snapshot.full) ? delta : snapshot.full;
      snapshot.transitions.set(previous, transition);
    }
    data = transition;
  }
  return { data, commit() { states.set(msg.t, snapshot); } };
}
