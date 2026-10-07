// Player settings (BGM/SFX/voice volume, mute, damage numbers, render quality, the shortcut keys): a tiny observable
// store persisted in localStorage (`sp.pref.settings`), applied to the audio manager on every change, plus
// the settings modal — which also holds the language switch (ui/lang.js; kept apart in `sp.pref.lang`; under it a note
// while the current language's pack is a machine translation, `_meta.machineTranslated`) and the 快捷键
// section that rebinds the in-match shortcuts (the key map: ui/gameLogic/shortcuts.js; the community request
// 「快捷键可不可以自己设置」, the owner's decision of 2026-10-07).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { sanitizeSettings, DEFAULT_SHORTCUTS, sanitizeShortcuts, shortcutLabel } from './gameLogic.js';
import { audio } from '../audio.js';
import { openGuide } from './guide.js';
import { detectFeatures } from './device.js';
import { ResourceRow } from './resourcePanel.js';
import { FRAME_RATES } from '../frameRate.js';
import { LangToggle, machineTranslationNote } from './lang.js';
import { t, tc, N_ } from '../../../shared/i18n.js';

import { AnnouncementButton } from './announcement.js';

/** Settings store: { bgm, sfx, voice, muted, damageNumbers, quality, fpsLimit, preload, preloadOptional }. */
export const settingsStore = createStore(sanitizeSettings(loadPref('settings', null)));
export const shortcutsStore = createStore(sanitizeShortcuts(loadPref('shortcuts', DEFAULT_SHORTCUTS)));

settingsStore.subscribe((s) => {
  savePref('settings', sanitizeSettings(s));
  audio.setVolumes(s);
});
shortcutsStore.subscribe((s) => savePref('shortcuts', sanitizeShortcuts(s)));
audio.setVolumes(settingsStore.get());

/** @param {Partial<ReturnType<typeof sanitizeSettings>>} patch */
export function updateSettings(patch) {
  settingsStore.set(sanitizeSettings({ ...settingsStore.get(), ...patch }));
}

/** Preact hook: current settings. */
export const useSettings = () => useStore((s) => s, Object.is, settingsStore);
export const useShortcuts = () => useStore((s) => s, Object.is, shortcutsStore);

/**
 * The label of the key a rebindable shortcut has right now ('R', 'Space' …) — the HUD's key hints (shop bar, ready /
 * pause, underframe). Read at render: the game screen re-renders when the settings dialog closes.
 * @param {'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'} action
 */
export const hotkeyLabelOf = (action) => shortcutLabel(shortcutsStore.get(), action);

function Slider({ label, micro, value, onInput, icon }) {
  const pct = Math.round(value * 100);
  return html`<label class="set-row">
    <span class="set-row__label"><${Icon} name=${icon} />${label}<${MicroLabel}>${micro}<//></span>
    <input class="set-range" type="range" min="0" max="100" step="5" value=${pct} style=${`--pct:${pct}%`}
      onInput=${(e) => onInput(Number(e.currentTarget.value) / 100)} />
    <span class="set-row__val num">${pct}</span>
  </label>`;
}

function Toggle({ label, micro, value, onChange }) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <button type="button" class=${`set-toggle${value ? ' is-on' : ''}`} role="switch" aria-checked=${value ? 'true' : 'false'}
      onClick=${() => onChange(!value)}><i></i><span>${value ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
  </div>`;
}

const QUALITY = [['high', N_('高')], ['medium', N_('中')], ['low', N_('低')]];
export function SettingsModal({ open, onClose }) {
  const s = useSettings();
  const [tested, setTested] = useState(false);
  const [touchUi] = useState(() => detectFeatures().coarse && !detectFeatures().fine);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const mtNote = machineTranslationNote(); // a pack marked as machine translation says so under the switch
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('设置')} micro="SETTINGS" width="7.4rem"
    actions=${html`<${AnnouncementButton} onClick=${onClose} /><${Button} variant="secondary" icon="book" class="set-guide" onClick=${() => openGuide(0)}>${t('玩法说明')}<//>
      <${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">${t('语言')}<${MicroLabel}>LANGUAGE<//></span>
        <${LangToggle} class="set-lang" />
      </div>
      ${mtNote ? html`<p class="set-hint set-lang-note" data-testid="lang-mt-note">${mtNote}</p>` : null}
      <${Slider} label=${t('背景音乐')} micro="BGM" icon="play" value=${s.bgm} onInput=${(v) => updateSettings({ bgm: v })} />
      <${Slider} label=${t('干员语音')} micro="VOICE" icon="mic" value=${s.voice} onInput=${(v) => updateSettings({ voice: v })} />
      <${Slider} label=${t('音效')} micro="SFX" icon="signal" value=${s.sfx}
        onInput=${(v) => { updateSettings({ sfx: v }); if (!tested) { setTested(true); setTimeout(() => setTested(false), 400); audio.sfx('click'); } }} />
      <${Toggle} label=${t('静音')} micro="MUTE" value=${s.muted} onChange=${(v) => updateSettings({ muted: v })} />
      <${Toggle} label=${t('显示伤害数字')} micro="DAMAGE NUMBERS" value=${s.damageNumbers} onChange=${(v) => updateSettings({ damageNumbers: v })} />
      <${ResourceRow} enabled=${s.preload} onChange=${(v) => updateSettings({ preload: v })} />
      <div class="set-row"><span class="set-row__label"><${Icon} name="keyboard" />${t('快捷键')}<${MicroLabel}>SHORTCUTS<//></span>
        <${Button} variant="secondary" icon="edit" onClick=${() => setShortcutOpen(true)}>${t('修改快捷键')}<//></div>
      <div class="set-row">
        <span class="set-row__label">${t('画面质量')}<${MicroLabel}>QUALITY<//></span>
        <div class="set-seg" role="radiogroup">
          ${QUALITY.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.quality === id ? 'true' : 'false'}
            class=${s.quality === id ? 'is-on' : ''} onClick=${() => updateSettings({ quality: id })}>${t(label)}</button>`)}
        </div>
      </div>
      <div class="set-row set-row--fps">
        <span class="set-row__label">${t('帧率上限')}<${MicroLabel}>FRAME RATE<//></span>
        <div class="set-seg set-seg--fps" role="radiogroup" aria-label=${t('帧率上限')}>
          ${FRAME_RATES.map((limit) => html`<button key=${limit} type="button" role="radio" aria-checked=${s.fpsLimit === limit ? 'true' : 'false'}
            aria-label=${limit ? `${limit} FPS` : t('不限帧率')} class=${s.fpsLimit === limit ? 'is-on' : ''}
            onClick=${() => updateSettings({ fpsLimit: limit })}>${limit || t('不限')}</button>`)}
        </div>
      </div>
      ${touchUi
        ? html`<p class="set-hint">${t('触屏操作：点击单位选中（撤退 / 出售）· 长按单位或卡牌查看详情 · 拖动部署后滑动选择朝向')}</p>`
        : html`<p class="set-hint">${t('快捷键可在“修改快捷键”中自定义。')}<kbd>Esc</kbd> ${t('关闭弹窗 · 右键查看详情')}</p>`}
    </div>
    <${ShortcutModal} open=${shortcutOpen} onClose=${() => setShortcutOpen(false)} />
  <//>`;
}

const SHORTCUT_LABELS = {
  viewEnemies: [N_('查看本回合怪物'), 'W'], freeze: [N_('冻结'), 'S'], refresh: [N_('刷新'), 'R'], ready: [N_('准备'), 'C'],
  sell: [N_('售卖当前选中干员'), 'X'], retreat: [N_('撤离当前干员'), 'Q'], levelUp: [N_('升级等级'), 'G'], pause: [N_('暂停/继续作战'), N_('空格')],
};

function ShortcutModal({ open, onClose }) {
  const shortcuts = useShortcuts();
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const listenRef = useRef(null);
  useEffect(() => { if (editing) listenRef.current?.focus?.(); }, [editing]);
  const setKey = (action, e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape') return;
    const code = e.code;
    if (!code || !/^Key[A-Z]|^Digit[0-9]|^Space$|^Arrow/.test(code)) { setError(t('请使用字母、数字、方向键或空格')); return; }
    const other = Object.entries(shortcuts).find(([a, v]) => a !== action && v === code);
    if (other) { setError(t('与“{0}”重复', { 0: t(SHORTCUT_LABELS[other[0]]?.[0] || other[0]) })); return; }
    shortcutsStore.set({ [action]: code }); setEditing(null); setError('');
  };
  const reset = () => { shortcutsStore.set({ ...DEFAULT_SHORTCUTS }); setEditing(null); setError(''); };
  const display = (code) => code === 'Space' ? t('空格') : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '方向');
  return html`<${Modal} open=${open} title=${t('修改快捷键')} micro="KEYBOARD SHORTCUTS" width="6.5rem" onClose=${onClose}
      actions=${html`<${Button} variant="secondary" icon="refresh" onClick=${reset}>${t('重置默认')}<//><${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="shortcut-list">
      ${Object.entries(SHORTCUT_LABELS).map(([action, [label]]) => html`<div key=${action} class="shortcut-row">
        <span>${t(label)}</span>
        ${editing === action
          ? html`<button ref=${listenRef} type="button" class="shortcut-key is-listening" onKeyDown=${(e) => setKey(action, e)}>${t('请按键…')}</button>`
          : html`<button type="button" class="shortcut-key" onClick=${() => { setEditing(action); setError(''); }}>${display(shortcuts[action])}</button>`}
      </div>`)}
      ${error ? html`<p class="shortcut-error">${error}</p>` : html`<p class="set-hint">${t('点击按键后，再按下要绑定的新键。重复按键会被拒绝。')}</p>`}
    </div>
  <//>`;
}
