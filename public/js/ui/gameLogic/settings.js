import { normalizeFrameRate } from '../../frameRate.js';
// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, quality: 'high', fpsLimit: 0, preload: false, preloadOptional: false });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, quality: 'high'|'medium'|'low',
 *   keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    // optional asset preload (docs/ASSETS.md「Preload」): off unless the player turned it on
    preload: typeof r.preload === 'boolean' ? r.preload : DEFAULT_SETTINGS.preload,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
  };
}
