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

import { CACHE_PREFIX, MANIFEST_URL, SW_URL, TIER_ESSENTIAL, TIER_REST, checkAbort, formatBytes, isQuotaError, resourceGroup, normalizePreloadVoiceLang, resourceSelection, selectedResourceGroup, validateManifest } from './common.js';
import { ResourceStore } from './store.js';
import { t } from '../../../shared/i18n.js';

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
  voiceLang: 'cn',
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
let voiceLang = 'cn';
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
  // migration (kept bytes) vs network (fetched bytes): 0 unless a run is/was in flight
  adopted: s.adopted ?? 0,
  downloaded: s.downloaded ?? 0,
  ...resourceSelection(s, optional, voiceLang),
});

const selectionComplete = (s) => resourceSelection(s, optional, voiceLang).selectionComplete;

/** Why this browser cannot keep the resources (empty ⇒ it can). */
export function unsupportedReason() {
  if (!globalThis.isSecureContext) return t('需要 HTTPS（或 localhost）才能预载资源');
  if (!globalThis.caches) return t('当前浏览器不支持 Cache Storage');
  if (!globalThis.navigator?.serviceWorker) return t('当前浏览器不支持 Service Worker');
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
      return { error: t('无法读取资源清单：{0}', { 0: err?.message || err }) };
    }
    if (!res.ok) return { error: t('无法读取资源清单：HTTP {status}', { status: res.status }) };
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
export async function syncResources(enabled, includeOptional = optional, preloadVoiceLang = voiceLang) {
  enabled = !!enabled;
  const nextVoiceLang = normalizePreloadVoiceLang(preloadVoiceLang);
  const changed = optional !== !!includeOptional || voiceLang !== nextVoiceLang;
  if (enabled === current && !changed) { set({ enabled }); return; }
  const revision = ++syncRevision;
  current = enabled;
  optional = !!includeOptional;
  voiceLang = nextVoiceLang;
  set({ enabled, optional, voiceLang, ...resourceSelection(state, optional, voiceLang), error: false, message: '' });
  if (!enabled) {
    controller?.abort();
    archiveController?.abort();
    set({ phase: state.complete ? 'ready' : 'paused', message: state.complete ? t('预载已停止；已保存的资源保留，可继续下载或清理缓存。') : t('已停止预载。') });
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
    message: selectionComplete(st) ? t('所选资源已齐全。') : t('另一个标签页正在预载⋯回到这个标签页时会自动继续。'),
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
  set({ phase: 'checking', message: t('正在检查已保存的资源…'), error: false });
  const checkStart = performance.now();
  const ctx = await resourceContext();
  const manifestReady = performance.now();
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  if (ctx.error || ctx.unsupported || ctx.empty) {
    const message = ctx.error || ctx.unsupported || t('服务器没有可预载的资源');
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
    set({ worker: t('预载服务未启用（{0}），资源仍会下载，但不会从本机缓存读取。', { 0: err?.message || err }) });
  });
  const before = await store.status();
  console.info('[resources] preload check timings', { manifestMs: manifestReady - checkStart,
    ...before.checkTimings, durationMs: performance.now() - checkStart, cached: before.count, files: before.total });
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  const ready = selectionComplete(before);
  set({ ...counters(before), phase: ready ? 'ready' : 'download', message: ready ? optional ? t('所选资源已齐全。') : t('必备资源已预载完成；可选资源按需加载。') : '' });
  if (ready) { if (before.complete) await withDownloadLock(() => store.prune()); return; }
  const onProgress = (p) => {
    // "整理" instead of "下载" when the files came out of an older cache: nothing is being fetched (store.js 的迁移).
    const message = p.adopted > 0 && p.downloaded === 0 ? t('正在整理已保存的资源（无需重新下载）…') : '';
    set({ ...counters(p), phase: 'download', failed: p.failed, error: false, message });
  };
  try {
    // Required visuals first, then optional audio/tutorials when selected.
    const outcome = await withDownloadLock(async () => {
      checkAbort(signal);
      await store.download({ tiers: [TIER_ESSENTIAL], signal, onProgress });
      if (optional) await store.download({ tiers: [TIER_REST], signal, onProgress,
        includeFile: (file) => selectedResourceGroup(resourceGroup(file), true, voiceLang) });
      return { busy: false };
    });
    if (outcome.busy) { await watchOtherTab(store); return; }
    const after = await store.status();
    set({
      ...counters(after),
      phase: 'ready',
      error: false,
      message: !optional && selectionComplete(after) ? t('必备资源已预载完成；可选资源按需加载。') : after.complete
        ? t('资源已全部预载完成（{0}）。', { 0: formatBytes(after.bytes) })
        : selectionComplete(after) ? t('所选资源已齐全。') : t('已保存 {count}/{total} 个文件；未完成的会在下次开启时重试。', { count: after.count, total: after.total }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const now = await store.status().catch(() => null);
      set({ ...(now ? counters(now) : {}), phase: 'paused', message: current ? t('已暂停，可继续下载或清理缓存。') : t('已停止预载。') });
      return;
    }
    const message = err?.name === 'QuotaExceededError' || /quota|空间不足/i.test(String(err?.message || ''))
      ? t('浏览器存储空间不足：已保存的文件保留，可清理缓存后重试。')
      : t('预载失败：{0}', { 0: err?.message || err });
    const now = await store.status().catch(() => null);
    set({ ...(now ? counters(now) : {}), phase: 'error', message, error: true });
  }
}

/** Stop downloading (keeps what is cached). */
export function pauseResources() {
  archiveController?.abort();
  if (controller) {
    controller.abort();
    set({ message: t('正在暂停…') });
  }
}

/** ZIP support stays out of the initial module graph. An import can be started before enabling network preloading. */
export async function importResources(file, { onImported } = {}) {
  const outcome = await transferArchive('import', file);
  // Persist the UI setting after a successful import, then enable/resume the selected incremental downloads.
  onImported?.();
  const run = current ? startResources() : syncResources(true);
  void run.catch((err) => console.warn('[resources] enable after import failed', err));
  return outcome;
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
    message: kind === 'import' ? t('正在准备导入资源包…') : t('正在准备导出资源包…'), error: false });
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
          message: t('{0}资源包：{percent}%', { 0: p.phase === 'export' ? t('正在导出') : p.phase === 'verify' ? t('正在校验') : t('正在导入'), percent }) });
      };
      return kind === 'import'
        ? archive.importResourceZip(ctx.store, file, { signal, onProgress,
          onDiagnostics: (timings) => console.info('[resources] ZIP import timings', timings) })
        : archive.exportResourceZip(ctx.store, { signal, onProgress });
    });
    if (outcome.busy) throw new Error('另一个标签页正在处理资源，请暂停后重试');
    checkAbort(signal);
    const status = await ctx.store.status();
    const missing = resourceSelection(status, optional, voiceLang).selectedMissing;
    set({ ...counters(status), failed: 0, phase: selectionComplete(status) ? 'ready' : 'paused',
      message: kind === 'export'
        ? t('已导出 {count} 个资源文件。', { count: outcome.count })
        : t('已导入 {imported} 个资源文件，跳过 {skippedPackage} 个不适用的资源；{2}', { imported: outcome.imported, skippedPackage: outcome.skippedPackage, 2: missing === 0 ? t('所选资源已齐全。') : t('所选资源还需下载 {missing} 个文件。', { missing }) }) });
    if (kind === 'import') {
      await ensureWorker().catch((err) => set({ worker: t('预载服务未启用（{0}）', { 0: err?.message || err }) }));
    }
    checkAbort(signal);
    return outcome;
  })().catch(async (err) => {
    const ctx = await resourceContext();
    const status = await ctx.store?.status().catch(() => null);
    const aborted = err?.name === 'AbortError';
    set({ ...(status ? counters(status) : {}), phase: aborted ? 'paused' : 'error', error: !aborted,
      message: aborted ? t('资源包处理已取消，已保存的资源保留。')
        : isQuotaError(err) || /空间不足/i.test(String(err?.message || '')) ? t('浏览器存储空间不足，已保存的资源保留，可清理后重试。')
          : t('资源包{0}失败：{1}', { 0: kind === 'import' ? t('导入') : t('导出'), 1: err?.message || err }) });
    throw err;
  }).finally(() => {
    archiveController = null;
    transferPromise = null;
    set({ archive: '', archivePhase: '', archiveGroup: '' });
  });
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
    set({ message: t('另一个标签页正在处理资源，请暂停后再清理。') });
    return;
  }
  if (!current) await dropWorker();
  set({
    done: 0, tier1Done: 0, tier2Done: 0, bytes: 0, failed: 0, complete: false, error: false,
    phase: current ? 'paused' : 'off',
    message: t('已清理预载资源缓存。'),
    selectionComplete: false,
    ...resourceSelection({ groups: state.groups.map((g) => ({ ...g, present: 0, bytes: 0 })) }, optional, voiceLang),
  });
}

/** Opening the manager checks the cache without starting network asset downloads. */
export async function inspectResources() {
  // An active run already publishes authoritative counters; opening the panel must not enqueue another cache scan.
  if (activeRun || transferPromise) return;
  if (!activeRun && !transferPromise) set({ phase: 'checking', error: false, message: t('正在检查已保存的资源…') });
  const ctx = await resourceContext();
  if (!ctx.store) {
    set({ phase: 'error', supported: !ctx.unsupported, error: true, message: ctx.error || ctx.unsupported || t('服务器没有可预载的资源') });
    // A later open can retry a temporarily unavailable manifest.
    contextPromise = null;
    return;
  }
  try {
    if (activeRun || transferPromise) return;
    const status = await ctx.store.status();
    set({ ...counters(status), version: ctx.manifest.version, supported: true,
      ...(!activeRun && !transferPromise ? { phase: selectionComplete(status) ? 'ready' : 'paused', message: '', error: false } : {}) });
  } catch (err) {
    set({ phase: 'error', error: true, message: t('无法读取本机资源缓存：{0}', { 0: err?.message || err }) });
  }
}
