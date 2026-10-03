// assets.js — asset manifest (/data/assets.json, docs/ASSETS.md) URL helpers, image cache/preload, and the
// Spine loader (LRU + refcount + memory budget + timeout + concurrency cap) used by the battlefield renderer. A
// skeleton is never handed out while its unload is in flight (RefLru; user playtest #3 item 1: invisible models).
//
// Pure at import time: no PIXI, no DOM access until a loader actually runs (Node tests import this file).
//
//   import { assets } from './assets.js';          // browser singleton (manifest fetched on first use)
//   await assets.ready();                           // manifest loaded (or failed → every helper returns null)
//   assets.avatar('char_002_amiya', { e2: true })   // URL or null
//   const data = await assets.spine.acquire(entry); // spineData (PIXI.spine) — throws on failure/timeout
//   assets.spine.release(entry);
//   await assets.local();                           // optional local-client art manifest (data/local-assets.json,
//   assets.localUrl('map/autochess', 'TX_autochessi_D')   DESIGN §13) → URL or null (never required)
//
// Manifest URLs are normally same-origin paths (`/assets/…`), but SP_ASSETS_CDN makes the server rewrite them to
// absolute CDN URLs (docs/ASSETS.md「CDN」), so every helper here accepts both shapes (`isAssetUrl`).
//
// Every URL helper is also exported as a pure function taking the manifest first (`avatarUrl(manifest, …)`),
// so it can be unit tested without a browser. Helpers never throw on unknown ids — they return null and the
// caller falls back (docs/ASSETS.md "Other fallbacks").

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const get = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);

// ---- pure URL helpers (manifest first) ---------------------------------------------------------------------

/** Strip a trailing `_1` / `_2` art-phase suffix (data/chess.json asset ids). */
export function baseCharId(id) {
  const s = str(id);
  if (!s) return null;
  return s.replace(/_(1|2)$/, '');
}

/**
 * Operator avatar. Accepts a charId (`char_002_amiya`) or an asset id with the E2 suffix (`char_002_amiya_2`).
 * `opts.e2` prefers the E2 art. Falls back to the base avatar, then null.
 */
export function avatarUrl(m, id, opts) {
  const s = str(id);
  if (!s) return null;
  const direct = get(get(m, 'chars'), s);
  let rec = direct, e2 = !!(opts && opts.e2);
  if (!rec) {
    const base = baseCharId(s);
    rec = get(get(m, 'chars'), base);
    if (rec && /_2$/.test(s)) e2 = true;
  }
  if (rec) return str(e2 && rec.avatarE2) || str(rec.avatar) || null;
  return null;
}

/** Operator half-body portrait (`_1` base, `_2` E2). */
export function portraitUrl(m, id, opts) {
  const s = str(id);
  if (!s) return null;
  let rec = get(get(m, 'chars'), s), e2 = !!(opts && opts.e2);
  if (!rec) {
    rec = get(get(m, 'chars'), baseCharId(s));
    if (rec && /_2$/.test(s)) e2 = true;
  }
  if (!rec) return null;
  return str(e2 && rec.portraitE2) || str(rec.portrait) || null;
}

export function enemyIconUrl(m, enemyId) {
  const rec = get(get(m, 'enemies'), str(enemyId) || '');
  return str(rec && rec.icon);
}

/** Token avatar, falling back to its owner's avatar (docs/ASSETS.md token fallbacks). */
export function tokenAvatarUrl(m, tokenId) {
  const rec = get(get(m, 'tokens'), str(tokenId) || '');
  if (!rec) return null;
  return str(rec.avatar) || (rec.owner ? avatarUrl(m, rec.owner) : null) || str(get(get(get(m, 'prof'), 'battlecard'), 'token'));
}

export const bondIconUrl = (m, bondId) => str(get(get(m, 'bonds'), str(bondId) || ''));
export const bandIconUrl = (m, bandId) => str(get(get(m, 'bands'), str(bandId) || ''));

/** Item icon by trapId (`trap_1041_acarm041`) or item record (`{ trapId | iconId }`). */
export function itemIconUrl(m, item) {
  const id = isObj(item) ? (str(item.iconId) || str(item.trapId)) : str(item);
  return id ? str(get(get(m, 'items'), id)) : null;
}

/** Skill icon by iconId, or by skillId via `skillsById`. Falls back to the empty skill icon. */
export function skillIconUrl(m, id, opts) {
  const fallback = !(opts && opts.fallback === false);
  const s = str(id);
  const skills = get(m, 'skills');
  let url = s ? str(get(skills, s)) : null;
  if (!url && s) {
    const icon = str(get(get(m, 'skillsById'), s));
    if (icon) url = str(get(skills, icon));
  }
  return url || (fallback ? uiUrl(m, 'skillIcon/empty') : null);
}

/** UI sprite by `group/key` (e.g. 'battle/sprite_shadow'). */
export const uiUrl = (m, name) => str(get(get(m, 'ui'), str(name) || ''));

/** Profession icon: kind 'icon' | 'large' | 'battlecard'; profession in any case (SNIPER → sniper). */
export function profIconUrl(m, profession, kind = 'icon') {
  const p = str(profession);
  if (!p) return null;
  return str(get(get(get(m, 'prof'), kind), p.toLowerCase()));
}

/** Sub-profession icon by subProfessionId or `sub_<id>_icon` asset id. */
export function subProfIconUrl(m, sub) {
  const s = str(sub);
  if (!s) return null;
  const id = s.replace(/^sub_/, '').replace(/_icon$/, '');
  return str(get(get(get(m, 'prof'), 'sub'), id));
}

/**
 * Spine manifest entry for a unit asset id (operator charId, token id, enemy id). `opts.back` asks for the Back
 * model (operators only; falls back to Front). Enemy aliases are resolved transparently. Returns the Spine
 * object of docs/ASSETS.md or null.
 */
export function spineEntry(m, id, opts) {
  const s = str(id);
  if (!s) return null;
  const ch = get(get(m, 'chars'), s) || get(get(m, 'chars'), baseCharId(s));
  if (ch && isObj(ch.spine)) {
    const sp = (opts && opts.back && isObj(ch.spine.back)) ? ch.spine.back : ch.spine.front;
    return validSpine(sp) ? sp : null;
  }
  const tk = get(get(m, 'tokens'), s);
  if (tk) return validSpine(tk.spine) ? tk.spine : null;
  const en = get(get(m, 'enemies'), s);
  if (en) {
    if (validSpine(en.spine)) return en.spine;
    const alias = str(en.spineAliasOf);
    const al = alias ? get(get(m, 'enemies'), alias) : null;
    return al && validSpine(al.spine) ? al.spine : null;
  }
  return null;
}

/** Whether an operator/token/enemy has a Back model. */
export function hasBackSpine(m, id) {
  const ch = get(get(m, 'chars'), str(id) || '') || get(get(m, 'chars'), baseCharId(id) || '');
  return !!(ch && isObj(ch.spine) && validSpine(ch.spine.back));
}

/**
 * Whether a manifest string may be requested as art: a same-origin path (`/assets/…`) or an absolute http(s) URL —
 * an assets CDN rewrites the manifests to the latter (docs/ASSETS.md「CDN」). Anything else (a `javascript:` / `data:`
 * URL, a relative path) is refused, so a malformed manifest can never turn into an arbitrary request.
 * @param {unknown} v @param {string} [ext] required extension, e.g. '.skel'
 */
export function isAssetUrl(v, ext = '') {
  if (typeof v !== 'string' || v.length === 0 || /\s/.test(v)) return false;
  if (!v.startsWith('/') && !/^https?:\/\//i.test(v)) return false;
  return !ext || v.endsWith(ext);
}

export function validSpine(sp) {
  return isObj(sp) && isAssetUrl(sp.skel, '.skel') && typeof sp.atlas === 'string' && isObj(sp.anims);
}

/** Best 2D picture for a unit asset id (operator avatar, token avatar, enemy icon, item icon). */
export function unitPictureUrl(m, id) {
  return avatarUrl(m, id) || tokenAvatarUrl(m, id) || enemyIconUrl(m, id) || itemIconUrl(m, id) || null;
}

// ---- audio ---------------------------------------------------------------------------------------------------

/** BGM `{ intro?, loop }` for 'lobby' | 'prep' | 'combat' | 'boss', or a boss id. */
export function bgmEntry(m, kind) {
  const a = get(m, 'audio');
  const b = get(get(a, 'bossBgm'), str(kind) || '') || get(get(a, 'bgm'), str(kind) || '');
  return isObj(b) && str(b.loop) ? b : null;
}

/** SFX URL: group 'ui' | 'battle', key e.g. 'buy'. */
export const sfxUrl = (m, group, key) => str(get(get(get(get(m, 'audio'), 'sfx'), str(group) || ''), str(key) || ''));

/** Per-unit SFX: kind 'attack' | 'hit' | 'skill' | 'die' | 'born'; `skillIndex` picks `skills[i]` when present. */
export function unitSfxUrl(m, id, kind, skillIndex) {
  const u = get(get(get(get(m, 'audio'), 'sfx'), 'units'), str(id) || '') || get(get(get(get(m, 'audio'), 'sfx'), 'units'), baseCharId(id) || '');
  if (!isObj(u)) return null;
  if (kind === 'skill' && Number.isInteger(skillIndex) && isObj(u.skills)) {
    const s = str(u.skills[skillIndex]);
    if (s) return s;
  }
  return str(u[kind]);
}

// ---- generic caches ----------------------------------------------------------------------------------------

/**
 * LRU cache of refcounted async resources. `load(key, arg)` → Promise<value>; `unload(key, value, record)` frees it
 * (`record` is the cache record the value belonged to) and may return a promise that settles once it is freed.
 * Entries with refs > 0 are never evicted; the cache may exceed `max` while everything is in use.
 * Failures are remembered for `failTtl` ms (so a missing model is not refetched every frame) and rethrown.
 * Memory budget (optional): `weigh(key, value, arg)` → cost of a ready value; idle (refs 0) ready entries are evicted,
 * least recently used first, while their total weight exceeds `maxIdleWeight` — or `quietWeight` once nothing at all
 * has been referenced for `quietDelay` ms (no scene on screen; the instant zero in the middle of a scene switch is not
 * quiet) — once they have been idle for `idleGrace` ms (a scene switch releases and re-acquires its models within that
 * window, so it never reloads them); a timer sweeps what the grace held back.
 * `evictDelay` > 0: a release (or a finished load) schedules the eviction pass that much later instead of running it
 * at once, so a scene rebuilt in one go (every view destroyed, then the next scene's views built) never drops a value
 * it takes again.
 * A value whose unload is still in flight is never handed out again: a new load of that key waits for the unload to
 * settle (user playtest #3 item 1 — PIXI.Assets keeps an unloading skeleton in its loader cache until a microtask
 * later, so loading the same URL meanwhile returned the doomed skeleton, whose textures the unload then destroyed:
 * invisible operator models).
 */
export class RefLru {
  constructor({ load, unload = () => {}, max = 60, timeout = 20000, concurrency = 6, failTtl = 60000, now = () => Date.now(),
    weigh = null, maxIdleWeight = Infinity, quietWeight, idleGrace = 0, quietDelay = 0, evictDelay = 0, timers } = {}) {
    if (typeof load !== 'function') throw new TypeError('RefLru: load required');
    this._load = load;
    this._unload = unload;
    this.max = Math.max(1, max | 0);
    this.timeout = timeout;
    this.concurrency = Math.max(1, concurrency | 0);
    this.failTtl = failTtl;
    this.now = now;
    this._weigh = typeof weigh === 'function' ? weigh : null;
    const budget = (v, d) => (typeof v === 'number' && v >= 0 ? v : d);
    this.maxIdleWeight = budget(maxIdleWeight, Infinity);
    this.quietWeight = budget(quietWeight, this.maxIdleWeight);
    this.idleGrace = budget(idleGrace, 0);
    this.quietDelay = budget(quietDelay, 0);
    this.evictDelay = budget(evictDelay, 0);
    this._timers = timers && typeof timers.set === 'function' ? timers : {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t?.unref?.(); return t; },
      clear: (t) => clearTimeout(t),
    };
    this._sweep = null; // { timer, at } pending eviction pass (weight sweep / deferred eviction)
    /** @type {Map<string, { key, promise, value, state: 'loading'|'ready'|'failed', refs: number, used: number, weight: number, idleSince: number|null, error?, failedAt? }>} */
    this.map = new Map();
    this._refs = 0;             // Σ refs of every entry
    this._quietAt = this.now(); // since when nothing has been referenced (null while something is)
    /** @type {Map<string, Promise<void>>} key → unload still in flight (settles, never rejects) */
    this._unloading = new Map();
    this._active = 0;
    this._queue = [];
    this._tick = 0;
  }

  /** Synchronous peek: the value if ready (does not change refs). */
  peek(key) {
    const e = this.map.get(key);
    return e && e.state === 'ready' ? e.value : null;
  }

  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }

  /** Acquire a reference; resolves to the value (or rejects). Always pair with release(key). */
  acquire(key, arg) {
    let e = this.map.get(key);
    if (e && e.state === 'failed' && this.now() - e.failedAt > this.failTtl) { this.map.delete(key); e = null; }
    if (!e) {
      e = { key, promise: null, value: null, state: 'loading', refs: 0, used: ++this._tick, weight: 0, idleSince: null };
      this.map.set(key, e);
      // an unload of this key still in flight: load again only once it has settled (never the doomed value)
      const load = () => {
        const pending = this._unloading.get(key);
        return pending ? pending.then(() => this._load(key, arg)) : this._load(key, arg);
      };
      e.promise = this._schedule(() => this._withTimeout(load(), key)).then(
        (v) => {
          if (this.map.get(key) !== e) { this._unloadNow(key, v, e); return v; }
          e.value = v; e.state = 'ready';
          if (this._weigh) { let w = 0; try { w = Number(this._weigh(key, v, arg)); } catch { /* ignore */ } e.weight = w > 0 ? w : 0; }
          this._requestEvict();
          return v;
        },
        (err) => {
          e.state = 'failed'; e.error = err; e.failedAt = this.now();
          throw err;
        },
      );
      e.promise.catch(() => {});
    }
    e.refs++;
    this._refs++;
    this._quietAt = null;
    e.idleSince = null;
    e.used = ++this._tick;
    return e.promise;
  }

  /** Drop one reference (never below 0). */
  release(key) {
    const e = this.map.get(key);
    if (!e) return;
    if (e.refs > 0) {
      if (--e.refs === 0) e.idleSince = this.now();
      if (--this._refs <= 0) { this._refs = 0; this._quietAt = this.now(); }
    }
    e.used = ++this._tick;
    this._requestEvict();
  }

  /** Is an unload of `key` still in flight (a new load of it waits for it)? */
  unloading(key) { return this._unloading.has(key); }

  /** Evict now, or (evictDelay > 0) in one pass a moment later. */
  _requestEvict() {
    if (this.evictDelay > 0) this._sweepIn(this.evictDelay);
    else this._evict();
  }

  /**
   * Evict least-recently-used unreferenced ready/failed entries above `max`, then idle ready entries past their
   * grace while the idle weight is over budget (`maxIdleWeight`, or `quietWeight` once nothing has been referenced
   * for `quietDelay` ms).
   */
  _evict() {
    if (this.map.size > this.max) {
      const idle = [...this.map.values()].filter((e) => e.refs === 0 && e.state !== 'loading').sort((a, b) => a.used - b.used);
      for (const e of idle) {
        if (this.map.size <= this.max) break;
        this._drop(e);
      }
    }
    if (!this._weigh) return;
    let idleWeight = 0;
    const idle = [];
    for (const e of this.map.values()) {
      if (e.refs === 0 && e.state === 'ready') { idleWeight += e.weight; idle.push(e); }
    }
    const now = this.now();
    let budget = this.maxIdleWeight;
    let wait = Infinity;
    if (this._refs === 0) {
      const quietFor = now - (this._quietAt ?? now);
      if (quietFor >= this.quietDelay) budget = this.quietWeight;
      else if (idleWeight > this.quietWeight) wait = this.quietDelay - quietFor; // re-check once the quiet has lasted
    }
    if (idleWeight > budget) {
      idle.sort((a, b) => a.used - b.used);
      let graceWait = Infinity;
      for (const e of idle) {
        if (idleWeight <= budget) break;
        const age = now - (e.idleSince ?? now);
        if (age < this.idleGrace) { graceWait = Math.min(graceWait, this.idleGrace - age); continue; }
        idleWeight -= e.weight;
        this._drop(e);
      }
      if (idleWeight > budget) wait = Math.min(wait, graceWait);
    }
    if (wait < Infinity) this._sweepIn(wait);
  }

  _drop(e) {
    this.map.delete(e.key);
    if (e.state === 'ready') this._unloadNow(e.key, e.value, e);
  }

  /** Run the unload of a value; while a returned promise is pending, loads of that key wait (see the header). */
  _unloadNow(key, value, rec) {
    let p = null;
    try { p = this._unload(key, value, rec); } catch { p = null; }
    if (!p || typeof p.then !== 'function') return;
    const done = Promise.resolve(p).then(() => {}, () => {}).then(() => { if (this._unloading.get(key) === done) this._unloading.delete(key); });
    this._unloading.set(key, done);
  }

  /** Re-run eviction in `ms` (keeps the earliest pending pass). */
  _sweepIn(ms) {
    const at = this.now() + ms;
    if (this._sweep && this._sweep.at <= at) return;
    if (this._sweep) this._timers.clear(this._sweep.timer);
    const timer = this._timers.set(() => { this._sweep = null; this._evict(); }, Math.ceil(ms) + 5);
    this._sweep = { timer, at };
  }

  /** Unload everything (refs ignored). */
  clear() {
    if (this._sweep) { this._timers.clear(this._sweep.timer); this._sweep = null; }
    const all = [...this.map.values()];
    this.map.clear();
    this._refs = 0;
    this._quietAt = this.now();
    for (const e of all) if (e.state === 'ready') this._unloadNow(e.key, e.value, e);
  }

  stats() {
    let ready = 0, loading = 0, failed = 0, refs = 0, weight = 0, idleWeight = 0;
    for (const e of this.map.values()) {
      if (e.state === 'ready') ready++; else if (e.state === 'loading') loading++; else failed++;
      refs += e.refs;
      weight += e.weight || 0;
      if (e.refs === 0) idleWeight += e.weight || 0;
    }
    return { size: this.map.size, ready, loading, failed, refs, weight, idleWeight, active: this._active, queued: this._queue.length, unloading: this._unloading.size };
  }

  _schedule(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._active++;
        let p;
        try { p = Promise.resolve(fn()); } catch (err) { p = Promise.reject(err); }
        p.then(resolve, reject).finally(() => {
          this._active--;
          const next = this._queue.shift();
          if (next) next();
        });
      };
      if (this._active < this.concurrency) run(); else this._queue.push(run);
    });
  }

  _withTimeout(p, key) {
    if (!(this.timeout > 0)) return p;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`load timeout: ${key}`)), this.timeout);
      p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
    });
  }
}

/** URL of a local-client art entry from a data/local-assets.json manifest (`{ groups: { g: { name: { path } } } }`). */
export function localAssetUrl(m, group, name) {
  const e = get(get(get(m, 'groups'), str(group) || ''), str(name) || '');
  return isObj(e) ? str(e.path) : null;
}

/** Default browser image loader. */
export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image in this environment')); return; }
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

/** Default Spine loader: PIXI.Assets.load(skel) → spineData (needs globalThis.PIXI + PIXI.spine). */
export async function loadSpineData(entry) {
  const PIXI = globalThis.PIXI;
  if (!PIXI || !PIXI.Assets || !PIXI.spine) throw new Error('PIXI / pixi-spine not loaded');
  const res = await PIXI.Assets.load(entry.skel);
  const data = res && (res.spineData || res);
  if (!data || !Array.isArray(data.animations)) throw new Error(`bad spine data: ${entry.skel}`);
  return data;
}

/**
 * Estimated memory (bytes) held by a parsed skeleton (pixi-spine 3.8 SkeletonData): its typed/plain arrays (mesh
 * vertices/UVs/triangles, timeline frames/curves, deform frames, draw orders) plus a flat cost per object. A parsed
 * .skel costs ~10–15× its file size (0.1–1.4 MB files → ~1–12 MB of heap + backing store), mostly timelines, so a
 * count cap alone pins anywhere from tens to hundreds of MB; the spine LRU budgets idle skeletons by this weight.
 * Never throws; unknown shapes weigh `SPINE_WEIGHT_MIN`.
 */
export const SPINE_WEIGHT_MIN = 64 * 1024;
export function spineDataWeight(data) {
  if (!data || typeof data !== 'object') return SPINE_WEIGHT_MIN;
  const OBJ = 96, NUM = 8;
  const list = (a) => (Array.isArray(a) ? a : []);
  const arr = (a) => (!a || typeof a !== 'object' ? 0 : ArrayBuffer.isView(a) ? a.byteLength + OBJ
    : Array.isArray(a) ? a.length * NUM + OBJ : 0);
  let w = 0;
  try {
    for (const k of ['bones', 'slots', 'events', 'ikConstraints', 'transformConstraints', 'pathConstraints']) w += list(data[k]).length * OBJ * 2;
    for (const skin of list(data.skins)) {
      for (const slot of list(skin && skin.attachments)) {
        if (!slot || typeof slot !== 'object') continue;
        for (const at of Object.values(slot)) {
          w += OBJ * 2;
          if (at && typeof at === 'object') for (const f of ['vertices', 'regionUVs', 'uvs', 'triangles', 'bones', 'edges', 'lengths', 'offset']) w += arr(at[f]);
        }
      }
    }
    for (const anim of list(data.animations)) {
      w += OBJ;
      for (const t of list(anim && anim.timelines)) {
        if (!t || typeof t !== 'object') continue;
        w += OBJ + arr(t.frames) + arr(t.curves) + arr(t.attachmentNames) + arr(t.events);
        for (const f of list(t.frameVertices)) w += arr(f);
        for (const d of list(t.drawOrders)) w += arr(d);
      }
    }
  } catch { /* exotic shape: whatever was counted */ }
  return Math.max(SPINE_WEIGHT_MIN, w);
}

/** Atlas page image URLs of a Spine manifest entry (`textures`, else the `<skel name>.png` next to it). */
export function spinePages(entry) {
  if (!isObj(entry)) return [];
  const list = Array.isArray(entry.textures) ? entry.textures.filter((u) => str(u)) : [];
  if (list.length) return list;
  const skel = str(entry.skel);
  return skel ? [skel.replace(/\.skel$/, '.png')] : [];
}

/**
 * Free a skeleton evicted from the LRU: the skeleton asset, its .atlas asset (pixi-spine loads the atlas as a
 * separate cached asset, whose unload disposes the page textures on the GPU) AND the atlas page images: the atlas
 * parser loads each page through the loader (`loader.load({ src })`), so the decoded page (an ImageBitmap) stays in
 * `PIXI.Assets.loader.promiseCache` until that URL is unloaded too. Pages listed in `keep` (still used by another
 * cached skeleton) are left alone.
 * The unloads are asynchronous (PIXI frees an asset a microtask after the call, and until then `PIXI.Assets.load` of
 * the same URL hands out that doomed asset): the returned promise settles (never rejects) once every one has run, and
 * the spine LRU makes a new load of the skeleton wait for it (RefLru header).
 * @param {object} entry manifest spine entry { skel, atlas?, textures? }
 * @param {any} [_value] the unloaded spineData (unused)
 * @param {Set<string>} [keep] page URLs not to unload
 * @returns {Promise<void>|undefined}
 */
export function unloadSpineData(entry, _value, keep) {
  const PIXI = globalThis.PIXI;
  const skel = entry && entry.skel;
  if (!skel || !PIXI?.Assets?.unload) return undefined;
  const atlas = (typeof entry.atlas === 'string' && entry.atlas) || skel.replace(/\.skel$/, '.atlas');
  const loader = PIXI.Assets.loader;
  const pending = [];
  const unload = (url, direct) => {
    try {
      const p = direct && loader && typeof loader.unload === 'function' ? loader.unload(url) : PIXI.Assets.unload(url);
      pending.push(Promise.resolve(p).catch(() => {}));
    } catch { /* ignore */ }
  };
  unload(skel, false);
  unload(atlas, false);
  // pages were loaded by the atlas parser straight through the loader (never through Assets.load / the resolver)
  for (const url of spinePages(entry)) if (!(keep && keep.has(url))) unload(url, true);
  return Promise.all(pending).then(() => {});
}

// ---- store ---------------------------------------------------------------------------------------------------

/** Spine LRU memory budget: estimated bytes (`spineDataWeight`) of idle skeletons kept while a scene is shown. */
export const SPINE_IDLE_BYTES = 48 * 1024 * 1024;
/** How long a released skeleton is safe from the weight budget (a prep ⇄ battle switch re-acquires within it). */
export const SPINE_IDLE_GRACE_MS = 15000;
/**
 * Spine LRU eviction runs this long after a release, in one pass: a scene switch (battle → prep destroys every battle
 * view, then builds the prep views; prep → battle builds the battle views over the next frames) takes its models back
 * before anything is dropped (user playtest #3 item 1: the bench models were unloaded and re-loaded in one go).
 */
export const SPINE_EVICT_DELAY_MS = 1000;
/** Nothing referenced for this long = no scene on screen (lobby / room): the idle skeletons may all go. */
export const SPINE_QUIET_DELAY_MS = 3000;

/**
 * Create an asset store.
 * @param {{ url?: string, fetch?: typeof fetch, manifest?: object, loadImage?: (url) => Promise<any>,
 *           loadSpine?: (entry) => Promise<any>, unloadSpine?: (entry, value, keepPages:Set<string>) => (Promise<void>|void),
 *           spineMax?: number, spineTimeout?: number, spineWeigh?: (key, spineData) => number, spineIdleBytes?: number,
 *           spineQuietBytes?: number, spineIdleGrace?: number, spineEvictDelay?: number, spineQuietDelay?: number,
 *           spineTimers?: { set, clear }, spineNow?: () => number }} [opts]
 */
export function createAssets(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const url = opts.url || '/data/assets.json';
  const localUrl = opts.localUrl || '/data/local-assets.json';
  let localPromise = isObj(opts.localManifest) ? Promise.resolve(opts.localManifest) : null;
  let localManifest = isObj(opts.localManifest) ? opts.localManifest : null;
  const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  let manifest = isObj(opts.manifest) ? opts.manifest : null;
  let readyPromise = manifest ? Promise.resolve(manifest) : null;
  const loadImage = opts.loadImage || loadImageElement;
  const images = new Map(); // url → { promise, value }

  function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        try {
          const res = await doFetch(url, { cache: 'no-cache' });
          if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '???'}`);
          const json = await res.json();
          manifest = isObj(json) ? json : {};
        } catch (err) {
          console.warn(`[assets] ${url} unavailable (${err?.message || err}); using fallbacks`);
          manifest = {};
        }
        return manifest;
      })();
    }
    return readyPromise;
  }

  const spineEntries = new Map(); // skel URL → manifest entry (for the atlas / page URLs on unload)
  const spine = new RefLru({
    load: (key, entry) => { spineEntries.set(key, entry); return (opts.loadSpine || loadSpineData)(entry); },
    unload: (key, value, rec) => {
      // a late value of an entry that was dropped while loading, with the key already loading/cached again: the
      // PIXI caches are shared by URL, so unloading would pull the resources out from under the new entry
      const cur = spine.map.get(key);
      if (cur && rec && cur !== rec) return;
      const e = spineEntries.get(key) || { skel: key };
      spineEntries.delete(key);
      const keep = new Set();
      for (const [k, other] of spineEntries) if (k !== key && spine.map.has(k)) for (const u of spinePages(other)) keep.add(u);
      // the promise (when the unloader returns one) holds back a new load of this skeleton until it has settled
      return (opts.unloadSpine || unloadSpineData)(e, value, keep);
    },
    max: opts.spineMax ?? 60,
    timeout: opts.spineTimeout ?? 20000,
    concurrency: opts.spineConcurrency ?? 6,
    // memory budget (a parsed skeleton holds ~0.1–12 MB): idle skeletons beyond SPINE_IDLE_BYTES go, and all of
    // them once no scene has referenced any for SPINE_QUIET_DELAY_MS (lobby / room), each after a grace that covers a
    // prep ⇄ battle switch; evictions run SPINE_EVICT_DELAY_MS after the release that allows them (a scene switch
    // takes its models back first)
    weigh: opts.spineWeigh || ((key, value) => spineDataWeight(value)),
    maxIdleWeight: opts.spineIdleBytes ?? SPINE_IDLE_BYTES,
    quietWeight: opts.spineQuietBytes ?? 0,
    idleGrace: opts.spineIdleGrace ?? SPINE_IDLE_GRACE_MS,
    quietDelay: opts.spineQuietDelay ?? SPINE_QUIET_DELAY_MS,
    evictDelay: opts.spineEvictDelay ?? SPINE_EVICT_DELAY_MS,
    timers: opts.spineTimers,
    now: opts.spineNow,
  });

  /** Image element (cached; failures resolve to null). */
  function image(u) {
    const s = str(u);
    if (!s) return Promise.resolve(null);
    let e = images.get(s);
    if (!e) {
      e = { value: null, done: false, promise: null };
      e.promise = Promise.resolve().then(() => loadImage(s)).then(
        (img) => { e.value = img; e.done = true; return img; },
        () => { e.done = true; return null; },
      );
      images.set(s, e);
    }
    return e.promise;
  }

  /** Optional local-client art manifest (null when absent: every consumer falls back). Fetched once. */
  function local() {
    if (!localPromise) {
      localPromise = (async () => {
        try {
          const res = await doFetch(localUrl, { cache: 'no-cache' });
          if (!res || !res.ok) return null;
          const json = await res.json();
          localManifest = isObj(json) && isObj(json.groups) ? json : null;
        } catch { localManifest = null; }
        return localManifest;
      })();
    }
    return localPromise;
  }

  const m = () => manifest || {};
  return {
    ready,
    local,
    localUrl: (group, name) => localAssetUrl(localManifest, group, name),
    get manifest() { return manifest; },
    get loaded() { return !!manifest; },
    avatar: (id, o) => avatarUrl(m(), id, o),
    portrait: (id, o) => portraitUrl(m(), id, o),
    enemyIcon: (id) => enemyIconUrl(m(), id),
    tokenAvatar: (id) => tokenAvatarUrl(m(), id),
    bondIcon: (id) => bondIconUrl(m(), id),
    bandIcon: (id) => bandIconUrl(m(), id),
    itemIcon: (item) => itemIconUrl(m(), item),
    skillIcon: (id, o) => skillIconUrl(m(), id, o),
    profIcon: (p, kind) => profIconUrl(m(), p, kind),
    subProfIcon: (s) => subProfIconUrl(m(), s),
    ui: (name) => uiUrl(m(), name),
    picture: (id) => unitPictureUrl(m(), id),
    spineEntry: (id, o) => spineEntry(m(), id, o),
    hasBack: (id) => hasBackSpine(m(), id),
    audio: {
      bgm: (kind) => bgmEntry(m(), kind),
      sfx: (group, key) => sfxUrl(m(), group, key),
      unit: (id, kind, idx) => unitSfxUrl(m(), id, kind, idx),
    },
    /** Cached image element promise (null on failure). */
    image,
    /** Already-loaded image element or null (sync). */
    imageNow(u) { const e = images.get(str(u) || ''); return e && e.done ? e.value : null; },
    /**
     * Preload URLs; `onProgress(done, total, url)` after each. Resolves to { ok, failed } counts (never rejects).
     */
    async preload(urls, onProgress) {
      const list = [...new Set((Array.isArray(urls) ? urls : []).map(str).filter(Boolean))];
      let done = 0, ok = 0;
      await Promise.all(list.map((u) => image(u).then((img) => {
        done++;
        if (img) ok++;
        try { onProgress?.(done, list.length, u); } catch { /* ignore */ }
      })));
      return { ok, failed: list.length - ok, total: list.length };
    },
    /** Spine data LRU: acquire(entry) → Promise<spineData>; release(entry); peek(entry). */
    spine: {
      acquire: (entry) => (validSpine(entry) ? spine.acquire(entry.skel, entry) : Promise.reject(new Error('no spine entry'))),
      release: (entry) => { if (entry && entry.skel) spine.release(entry.skel); },
      peek: (entry) => (entry && entry.skel ? spine.peek(entry.skel) : null),
      stats: () => spine.stats(),
      clear: () => spine.clear(),
      cache: spine,
    },
  };
}

/** Browser singleton. */
export const assets = createAssets();
