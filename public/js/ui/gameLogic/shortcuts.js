// ui/gameLogic/shortcuts.js — in-match keyboard shortcuts and the player's key map (设置 → 快捷键, 0.2.0: the community
// request 「快捷键可不可以自己设置」, the owner's decision of 2026-10-07). Re-exported from ../gameLogic.js.

import { isObj } from './shared.js';
import { t } from '../../../../shared/i18n.js';


// ---- keyboard ---------------------------------------------------------------------------------------------------

/**
 * Map a keydown to a game shortcut under the player's key map (defaults: R refresh, F freeze, D level-up, Q retreat,
 * X sell, Space ready) or Esc (close; fixed). A shortcut key means its action even while a HUD button has focus (a
 * mouse click leaves the shop card / 刷新 focused, and Space must not re-trigger it); the caller prevents the button's
 * own activation. Enter still activates buttons (it cannot be a shortcut). Nothing while Ctrl / ⌘ / Alt is held or a
 * text field has the focus.
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean, target?: any }} e
 * @param {any} [keys] the player's map (settings `keys`)
 * @returns {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'|'escape'|null}
 */
export function shortcutFor(e, shortcuts = null) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target;
  const tag = t && typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return null;
  if (e.key === 'Escape') return 'escape';
  if (e.repeat) return null;
  const code = e.code || '';
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  const configured = shortcuts && typeof shortcuts === 'object' ? shortcuts : null;
  if (configured) {
    for (const [act, binding] of Object.entries(configured)) if (binding && (code === binding || (!code && key === binding.toLowerCase()))) return act;
  } else {
    // Compatibility for pure helper callers from older clients; GameScreen always passes the persisted defaults.
    if (code === 'KeyR' || key === 'r') return 'refresh';
    if (code === 'KeyF' || key === 'f') return 'freeze';
    if (code === 'KeyD' || key === 'd') return 'levelUp';
    if (code === 'Space' || key === ' ') return 'ready';
  }
  return null;
}

/**
 * Whether the facing wheel swallows a key press: no ready / shop action while a facing is chosen — Space (a focused
 * button must not activate either) and every key bound to a shortcut.
 * @param {{ key?: string, code?: string }} e
 * @param {any} [keys] the player's map
 */
export const facingSwallows = (e, keys = DEFAULT_SHORTCUTS) => e?.key === ' ' || shortcutFor(e, keys) != null;

/**
 * Whether a press on the field closes the open detail card: a card opened from the field itself (an own piece — tap,
 * right-click or long press — or a battle / teammate unit). Shop, reward, bond-member and intel (enemy) cards stay.
 * @param {{ kind?: string }|null|undefined} detail
 */
// a card opened BY a field press (a piece, a unit, a special terrain tile: issue #184) closes on the next press of
// the field; the ones opened from the shop / hand / HUD stay until their own close button (or the flow that opened them)
export const closesOnFieldPress = (detail) => detail?.kind === 'piece' || detail?.kind === 'unit' || detail?.kind === 'terrain';

/**
 * Whether an open overlay swallows a game shortcut: a modal / the guide own the keyboard (Esc included — they close
 * themselves); the 本局信息 / 敌方情报 drawer is a dialog too — only Esc (it closes the drawer) passes, the other
 * shortcuts never act behind it.
 * @param {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'|'escape'|null} act shortcutFor
 * @param {{ modal?: boolean, drawer?: boolean }} open
 */
export function shortcutBlocked(act, { modal = false, drawer = false } = {}) {
  if (!act) return true;
  if (modal) return true;
  return !!drawer && act !== 'escape';
}

export const DEFAULT_SHORTCUTS = Object.freeze({
  viewEnemies: 'KeyW', freeze: 'KeyS', refresh: 'KeyR', ready: 'KeyC', sell: 'KeyX', retreat: 'KeyQ', levelUp: 'KeyG', pause: 'Space',
});

export const sanitizeShortcuts = (raw) => {
  const source = isObj(raw) ? raw : {};
  const out = {};
  for (const action of SHORTCUT_ACTIONS) {
    const v = source[action];
    out[action] = typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]+$/.test(v) ? v : DEFAULT_SHORTCUTS[action];
  }
  return out;
};

export const shortcutLabel = (shortcuts, action) => {
  const code = shortcuts?.[action] || DEFAULT_SHORTCUTS[action];
  if (code === 'Space') return t('空格');
  if (code?.startsWith('Key')) return code.slice(3);
  if (code?.startsWith('Digit')) return code.slice(5);
  if (code?.startsWith('Arrow')) return t('方向{0}', { 0: code.slice(5) });
  return code || '';
};

const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS);
