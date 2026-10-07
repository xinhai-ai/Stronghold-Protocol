// public/js/resources/index.js — the page side of the optional asset preload (docs/ASSETS.md「Preload」).
//
// Off by default (设置 ▸ 预载资源). When the player turns it on, this module fetches /data/resource-manifest.json,
// registers the Service Worker (public/resource-sw.js, so the cached files are also served with no network) and fills
// Cache Storage with required visuals first, then optional audio/tutorials when selected. Turning it off stops the
// downloads; 「清理缓存」 deletes them. Nothing here touches the match: a player who never enables it never downloads
// anything, and a failed download only costs a console message.
//
// The settings panel (public/js/ui/resourcePanel.js) renders `resourceState()`; main.js calls `syncResources()` with the
// persisted setting at boot and on every settings change.

import { CACHE_PREFIX, MANIFEST_URL, SW_URL, TIER_ESSENTIAL, TIER_REST, checkAbort, formatBytes, resourceGroup, validateManifest } from './common.js';
import { ResourceStore } from './store.js';

/** @type {any} */
const state = {
  enabled: false,
  phase: 'off', // off | checking | download | foreign (another tab) | ready | paused | error
  supported: true,
  reason: '',
  done: 0,
  total: 0,
  wanted: 0,
  tier1Done: 0,
  tier1Total: 0,
  tier2Done: 0,
  tier2Total: 0,
  bytes: 0,
  totalBytes: null,
  sized: 0,
  sizedTotal: 0,
  skipped: 0,
  failed: 0,
  complete: false,
  message: '',
  error: false,
  worker: '',
  version: '',
  archive: '', // import | export; separate from download progress
  archivePhase: '',
  archivePercent: 0,
  archiveGroup: '',
  optional: false,
  selectionComplete: false,
  groups: [],
};

const listeners = new Set();
let current = false;
let controller = null;
let contextPromise = null;
let activeRun = null;
let transferPromise = null;
let archiveController = null;
let optional = false;
let syncRevision = 0;

/** Subscribe to preload state changes (returns the unsubscribe function). */
export function subscribeResources(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A copy of the current preload state (safe to hand to Preact). */
export function resourceState() {
  return { ...state };
}

function set(patch) {
  const before = JSON.stringify(state); // the state is small and flat: a cheap "did anything change" test
  Object.assign(state, patch);
  if (JSON.stringify(state) === before) return;
  for (const fn of [...listeners]) {
    try { fn(resourceState()); } catch (err) { console.error('[resources] listener failed', err); }
  }
}

/**
 * The counters of one store payload (status / progress / result — store.js emits the same fields for all three), in the
 * names the panel renders. One shape for all three is what keeps a progress update from leaving a field undefined.
 */
const counters = (s) => ({
  done: s.count,
  total: s.total,
  wanted: s.wanted,
  tier1Done: s.tier1Present,
  tier1Total: s.tier1,
  tier2Done: s.tier2Present,
  tier2Total: s.tier2,
  tier1Wanted: s.tier1Wanted ?? s.tier1,
  tier2Wanted: s.tier2Wanted ?? s.tier2,
  bytes: s.bytes,
  totalBytes: s.totalBytes,
  sized: s.sized,
  sizedTotal: s.sizedTotal,
  skipped: s.skipped,
  complete: s.complete,
  selectionComplete: selectionComplete(s),
  // migration (kept bytes) vs network (fetched bytes): 0 unless a run is/was in flight
  adopted: s.adopted ?? 0,
  downloaded: s.downloaded ?? 0,
  groups: s.groups ?? [],
});

const selectionComplete = (s) => (s.tier1Present >= (s.tier1Wanted ?? s.tier1))
  && (!optional || s.tier2Present >= (s.tier2Wanted ?? s.tier2));

/** Why this browser cannot keep the resources (empty ⇒ it can). */
export function unsupportedReason() {
  if (!globalThis.isSecureContext) return '需要 HTTPS（或 localhost）才能预载资源';
  if (!globalThis.caches) return '当前浏览器不支持 Cache Storage';
  if (!globalThis.navigator?.serviceWorker) return '当前浏览器不支持 Service Worker';
  return '';
}

/**
 * The preload context: the manifest plus (when this browser can cache) its store. Cached for the session; a failure is
 * retried the next time the player enables the preload.
 */
export function resourceContext() {
  contextPromise ??= (async () => {
    const reason = unsupportedReason();
    if (reason) return { unsupported: reason }; // no point in asking for a list this browser cannot store
    let res;
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
      // Revalidate the HTTP cache on every page load. On a wire-level 304 the browser supplies the cached JSON body.
      res = await fetch(MANIFEST_URL, { cache: 'no-cache', signal });
    } catch (err) {
      return { error: `无法读取资源清单：${err?.message || err}` };
    }
    if (!res.ok) return { error: `无法读取资源清单：HTTP ${res.status}` };
    let manifest;
    try {
      manifest = validateManifest(await res.json());
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    if (!manifest.files.length) return { manifest, empty: true };
    return { manifest, store: new ResourceStore(manifest) };
  })();
  return contextPromise;
}

/** Register the Service Worker that serves the cached files (downloads work without it). */
async function ensureWorker() {
  const nav = globalThis.navigator;
  if (!nav?.serviceWorker) throw new Error('不支持 Service Worker');
  const reg = await nav.serviceWorker.register(SW_URL, { type: 'module', scope: '/', updateViaCache: 'none' });
  set({ worker: '' });
  return reg;
}

/** Unregister the worker (nothing to serve from the cache any more). */
async function dropWorker() {
  const nav = globalThis.navigator;
  if (!nav?.serviceWorker) return;
  try {
    for (const reg of await nav.serviceWorker.getRegistrations()) {
      const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
      if (url.endsWith(SW_URL)) await reg.unregister();
    }
  } catch { /* the worker is optional */ }
}

/**
 * Turn the preload on or off (idempotent: the settings store fires on every volume change).
 * @param {boolean} enabled
 */
export async function syncResources(enabled, includeOptional = optional) {
  enabled = !!enabled;
  const changed = optional !== !!includeOptional;
  if (enabled === current && !changed) { set({ enabled }); return; }
  const revision = ++syncRevision;
  current = enabled;
  optional = !!includeOptional;
  set({ enabled, optional, error: false, message: '' });
  if (!enabled) {
    controller?.abort();
    archiveController?.abort();
    set({ phase: state.complete ? 'ready' : 'paused', message: state.complete ? '预载已停止；已保存的资源保留，可继续下载或清理缓存。' : '已停止预载。' });
    return;
  }
  if (changed) controller?.abort();
  if (activeRun && controller?.signal.aborted) await activeRun;
  if (revision !== syncRevision || !current) return;
  return start();
}

/** Continue (or start) the download of an enabled preload. */
export async function startResources() {
  if (!current) return;
  return start();
}

/**
 * The download of one tab at a time (Web Locks): Cache Storage is shared by every tab of the origin, so without this
 * two tabs of the same session would fetch the same ~250 MiB twice. The second tab does not queue behind the first: it
 * reports what is already cached and re-checks when the player comes back to it (`ifAvailable`).
 */
export const DOWNLOAD_LOCK = 'stronghold-resources-preload';

/** Run `job` while holding the download lock; `{ busy: true }` when another tab has it. Unsupported ⇒ just run it. */
async function withDownloadLock(job) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return job();
  return locks.request(DOWNLOAD_LOCK, { ifAvailable: true }, async (lock) => (lock ? job() : { busy: true }));
}

/** Another tab owns the download: show what is cached and look again when this tab becomes visible. */
function watchOtherTab(store) {
  if (globalThis.document?.addEventListener) {
    const recheck = () => {
      if (document.visibilityState !== 'visible' || !current) return;
      document.removeEventListener('visibilitychange', recheck);
      void startResources();
    };
    document.addEventListener('visibilitychange', recheck);
  }
  return store.status().then((st) => set({
    ...counters(st), phase: 'foreign', error: false,
    message: st.complete ? '资源已全部预载完成。' : '另一个标签页正在预载⋯回到这个标签页时会自动继续。',
  }));
}

function start() {
  if (transferPromise) return transferPromise.catch(() => {});
  if (activeRun) return activeRun;
  controller = new AbortController();
  const signal = controller.signal;
  activeRun = startDownload(signal).finally(() => { activeRun = null; controller = null; });
  return activeRun;
}

async function startDownload(signal) {
  set({ phase: 'checking', message: '正在检查已保存的资源…', error: false });
  const ctx = await resourceContext();
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  if (ctx.error || ctx.unsupported || ctx.empty) {
    const message = ctx.error || ctx.unsupported || '服务器没有可预载的资源';
    set({ phase: 'error', message, error: true, supported: !ctx.unsupported });
    if (ctx.unsupported) void dropWorker();
    return;
  }
  const store = ctx.store;
  set({ supported: true, version: store.manifest.version });
  // registering an already-registered worker is a cheap no-op, so every start can retry a failed one. A failure here
  // does NOT stop the download (the page fills Cache Storage itself) — it only means nothing can be served offline.
  ensureWorker().catch((err) => {
    console.warn('[resources] service worker not registered — the cached assets cannot be served without the network', err);
    set({ worker: `预载服务未启用（${err?.message || err}），资源仍会下载，但不会从本机缓存读取。` });
  });
  const before = await store.status();
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  const ready = selectionComplete(before);
  set({ ...counters(before), phase: ready ? 'ready' : 'download', message: ready ? optional ? '资源已全部预载完成。' : '必备资源已预载完成；可选资源按需加载。' : '' });
  if (ready) { if (before.complete) await withDownloadLock(() => store.prune()); return; }
  const onProgress = (p) => {
    // "整理" instead of "下载" when the files came out of an older cache: nothing is being fetched (store.js 的迁移).
    const message = p.adopted > 0 && p.downloaded === 0 ? '正在整理已保存的资源（无需重新下载）…' : '';
    set({ ...counters(p), phase: 'download', failed: p.failed, error: false, message });
  };
  try {
    // Required visuals first, then optional audio/tutorials when selected.
    const outcome = await withDownloadLock(async () => {
      checkAbort(signal);
      await store.download({ tiers: [TIER_ESSENTIAL], signal, onProgress });
      if (optional) await store.download({ tiers: [TIER_REST], signal, onProgress });
      return { busy: false };
    });
    if (outcome.busy) { await watchOtherTab(store); return; }
    const after = await store.status();
    set({
      ...counters(after),
      phase: 'ready',
      error: false,
      message: !optional && selectionComplete(after) ? '必备资源已预载完成；可选资源按需加载。' : after.complete
        ? `资源已全部预载完成（${formatBytes(after.bytes)}）。`
        : `已保存 ${after.count}/${after.total} 个文件；未完成的会在下次开启时重试。`,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const now = await store.status().catch(() => null);
      set({ ...(now ? counters(now) : {}), phase: 'paused', message: current ? '已暂停，可继续下载或清理缓存。' : '已停止预载。' });
      return;
    }
    const message = err?.name === 'QuotaExceededError' || /quota|空间不足/i.test(String(err?.message || ''))
      ? '浏览器存储空间不足：已保存的文件保留，可清理缓存后重试。'
      : `预载失败：${err?.message || err}`;
    const now = await store.status().catch(() => null);
    set({ ...(now ? counters(now) : {}), phase: 'error', message, error: true });
  }
}

/** Stop downloading (keeps what is cached). */
export function pauseResources() {
  archiveController?.abort();
  if (controller) {
    controller.abort();
    set({ message: '正在暂停…' });
  }
}

/** ZIP support stays out of the initial module graph. An import can be started before enabling network preloading. */
export function importResources(file) {
  return transferArchive('import', file);
}

export function exportResources() {
  return transferArchive('export');
}

function transferArchive(kind, file) {
  if (transferPromise) return Promise.reject(new Error('资源包正在处理中'));
  // Stop the whole two-tier run, not just the currently active store.download() call.
  controller?.abort();
  archiveController = new AbortController();
  const signal = archiveController.signal;
  set({ archive: kind, archivePhase: '', archivePercent: 0, archiveGroup: '',
    message: kind === 'import' ? '正在准备校验资源包…' : '正在准备导出资源包…', error: false });
  transferPromise = (async () => {
    if (activeRun) await activeRun;
    const ctx = await resourceContext();
    if (!ctx.store) throw new Error(ctx.error || ctx.unsupported || '服务器没有可预载的资源');
    checkAbort(signal);
    const outcome = await withDownloadLock(async () => {
      set(counters(await ctx.store.status()));
      const archive = await import('./archive.js');
      checkAbort(signal);
      let lastTime = -Infinity;
      let lastPhase = '';
      const onProgress = (p) => {
        const now = performance.now();
        // Keep hashing/cache writes running at full speed. UI and category aggregation run at most twice a second;
        // phase boundaries and completion always publish immediately, without timers that could outlive the job.
        if (p.phase === lastPhase && p.done < p.total && now - lastTime < 500) return;
        lastTime = now;
        lastPhase = p.phase;
        const percent = p.total > 0 ? Math.min(100, Math.floor(p.done * 100 / p.total)) : 100;
        const status = p.getStatus?.();
        set({ ...(status ? counters(status) : {}), archivePhase: p.phase, archivePercent: percent,
          archiveGroup: p.file ? resourceGroup(p.file) : '',
          message: `${p.phase === 'export' ? '正在导出' : p.phase === 'verify' ? '正在校验' : '正在导入'}资源包：${percent}%` });
      };
      return kind === 'import'
        ? archive.importResourceZip(ctx.store, file, { signal, onProgress })
        : archive.exportResourceZip(ctx.store, { signal, onProgress });
    });
    if (outcome.busy) throw new Error('另一个标签页正在处理资源，请暂停后重试');
    checkAbort(signal);
    const status = await ctx.store.status();
    const missing = status.tier1Wanted - status.tier1Present + (optional ? status.tier2Wanted - status.tier2Present : 0);
    set({ ...counters(status), failed: 0, phase: selectionComplete(status) ? 'ready' : 'paused',
      message: kind === 'export'
        ? `已导出 ${outcome.count} 个资源文件。`
        : `已导入 ${outcome.imported} 个资源文件，跳过 ${outcome.skippedPackage} 个不适用的资源；${missing === 0 ? '所选资源已齐全。' : `所选资源还需下载 ${missing} 个文件。`}` });
    if (kind === 'import') {
      await ensureWorker().catch((err) => set({ worker: `预载服务未启用（${err?.message || err}）` }));
    }
    checkAbort(signal);
    return outcome;
  })().catch(async (err) => {
    const ctx = await resourceContext();
    const status = await ctx.store?.status().catch(() => null);
    const aborted = err?.name === 'AbortError';
    set({ ...(status ? counters(status) : {}), phase: aborted ? 'paused' : 'error', error: !aborted,
      message: aborted ? '资源包处理已取消，已保存的资源保留。'
        : /quota|空间不足/i.test(String(err?.message || '')) ? '浏览器存储空间不足，已保存的资源保留，可清理后重试。'
          : `资源包${kind === 'import' ? '导入' : '导出'}失败：${err?.message || err}` });
    throw err;
  }).finally(() => {
    archiveController = null;
    transferPromise = null;
    set({ archive: '', archivePhase: '', archiveGroup: '' });
  });
  // The caller enables preloading after a successful import; an already-enabled preload resumes incrementally.
  if (kind === 'import') transferPromise.then(() => { if (current) void startResources().catch(() => {}); }, () => {});
  return transferPromise;
}

/**
 * Delete every cached resource (all versions) and stop.
 */
export async function clearResources() {
  controller?.abort();
  archiveController?.abort();
  if (activeRun) await activeRun;
  if (transferPromise) { try { await transferPromise; } catch { /* cancelled */ } }
  const ctx = await resourceContext();
  // a run that was mid-file finishes (or aborts) before the caches go away, so nothing lands after the clear
  if (ctx.store?.running) { try { await ctx.store.running; } catch { /* aborted — nothing to keep */ } }
  const outcome = await withDownloadLock(async () => {
    if (ctx.store) await ctx.store.clear();
    else if (globalThis.caches) {
      const names = await globalThis.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => globalThis.caches.delete(n)));
    }
    return { busy: false };
  });
  if (outcome.busy) {
    set({ message: '另一个标签页正在处理资源，请暂停后再清理。' });
    return;
  }
  if (!current) await dropWorker();
  set({
    done: 0, tier1Done: 0, tier2Done: 0, bytes: 0, failed: 0, complete: false, error: false,
    phase: current ? 'paused' : 'off',
    message: '已清理预载资源缓存。',
    selectionComplete: false,
    groups: state.groups.map((g) => ({ ...g, present: 0, bytes: 0 })),
  });
}

/** Opening the manager checks the cache without starting network asset downloads. */
export async function inspectResources() {
  if (!activeRun && !transferPromise) set({ phase: 'checking', error: false, message: '正在检查已保存的资源…' });
  const ctx = await resourceContext();
  if (!ctx.store) {
    set({ phase: 'error', supported: !ctx.unsupported, error: true, message: ctx.error || ctx.unsupported || '服务器没有可预载的资源' });
    // A later open can retry a temporarily unavailable manifest.
    contextPromise = null;
    return;
  }
  try {
    const status = await ctx.store.status();
    set({ ...counters(status), version: ctx.manifest.version, supported: true,
      ...(!activeRun && !transferPromise ? { phase: selectionComplete(status) ? 'ready' : 'paused', message: '', error: false } : {}) });
  } catch (err) {
    set({ phase: 'error', error: true, message: `无法读取本机资源缓存：${err?.message || err}` });
  }
}
