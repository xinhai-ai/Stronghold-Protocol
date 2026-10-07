// Player settings (BGM/SFX/voice volume, mute, damage numbers, render quality): a tiny observable store
// persisted in localStorage (`sp.pref.settings`), applied to the audio manager on every change, plus
// the settings modal.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { sanitizeSettings, DEFAULT_SHORTCUTS, sanitizeShortcuts } from './gameLogic.js';
import { audio } from '../audio.js';
import { openGuide } from './guide.js';
import { detectFeatures } from './device.js';
import { ResourceRow } from './resourcePanel.js';
import { FRAME_RATES } from '../frameRate.js';
import { AnnouncementButton } from './announcement.js';

/** Settings store: { bgm, sfx, voice, muted, damageNumbers, quality, fpsLimit, preload }. */
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
      onClick=${() => onChange(!value)}><i></i><span>${value ? '开启' : '关闭'}</span></button>
  </div>`;
}

const QUALITY = [['high', '高'], ['medium', '中'], ['low', '低']];

/**
 * Settings modal.
 * @param {{ open: boolean, onClose: Function }} props
 */
export function SettingsModal({ open, onClose }) {
  const s = useSettings();
  const [tested, setTested] = useState(false);
  const [touchUi] = useState(() => detectFeatures().coarse && !detectFeatures().fine);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  return html`<${Modal} open=${open} onClose=${onClose} title="设置" micro="SETTINGS" width="7.4rem"
    actions=${html`<${AnnouncementButton} onClick=${onClose} />
      <${Button} variant="secondary" icon="book" class="set-guide" onClick=${() => openGuide(0)}>玩法说明<//>
      <${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <${Slider} label="背景音乐" micro="BGM" icon="play" value=${s.bgm} onInput=${(v) => updateSettings({ bgm: v })} />
      <${Slider} label="干员语音" micro="VOICE" icon="mic" value=${s.voice} onInput=${(v) => updateSettings({ voice: v })} />
      <${Slider} label="音效" micro="SFX" icon="signal" value=${s.sfx}
        onInput=${(v) => { updateSettings({ sfx: v }); if (!tested) { setTested(true); setTimeout(() => setTested(false), 400); audio.sfx('click'); } }} />
      <${Toggle} label="静音" micro="MUTE" value=${s.muted} onChange=${(v) => updateSettings({ muted: v })} />
      <${Toggle} label="显示伤害数字" micro="DAMAGE NUMBERS" value=${s.damageNumbers} onChange=${(v) => updateSettings({ damageNumbers: v })} />
      <${ResourceRow} enabled=${s.preload} onChange=${(v) => updateSettings({ preload: v })} />
      <div class="set-row">
        <span class="set-row__label"><${Icon} name="keyboard" />快捷键<${MicroLabel}>SHORTCUTS<//></span>
        <${Button} variant="secondary" icon="edit" onClick=${() => setShortcutOpen(true)}>修改快捷键<//>
      </div>
      <div class="set-row">
        <span class="set-row__label">画面质量<${MicroLabel}>QUALITY<//></span>
        <div class="set-seg" role="radiogroup">
          ${QUALITY.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.quality === id ? 'true' : 'false'}
            class=${s.quality === id ? 'is-on' : ''} onClick=${() => updateSettings({ quality: id })}>${label}</button>`)}
        </div>
      </div>
      <div class="set-row set-row--fps">
        <span class="set-row__label">帧率上限<${MicroLabel}>FRAME RATE<//></span>
        <div class="set-seg set-seg--fps" role="radiogroup" aria-label="帧率上限">
          ${FRAME_RATES.map((limit) => html`<button key=${limit} type="button" role="radio" aria-checked=${s.fpsLimit === limit ? 'true' : 'false'}
            aria-label=${limit ? `${limit} FPS` : '不限帧率'} class=${s.fpsLimit === limit ? 'is-on' : ''}
            onClick=${() => updateSettings({ fpsLimit: limit })}>${limit || '不限'}</button>`)}
        </div>
      </div>
      ${touchUi
        ? html`<p class="set-hint">触屏操作：点击单位选中（撤退 / 出售）· 长按单位或卡牌查看详情 · 拖动部署后滑动选择朝向</p>`
        : html`<p class="set-hint">快捷键可在“修改快捷键”中自定义。<kbd>Esc</kbd> 关闭弹窗 · 右键查看详情</p>`}
    </div>
    <${ShortcutModal} open=${shortcutOpen} onClose=${() => setShortcutOpen(false)} />
  <//>`;
}

const SHORTCUT_LABELS = {
  viewEnemies: ['查看本回合怪物', 'W'], freeze: ['冻结', 'S'], refresh: ['刷新', 'R'], ready: ['准备', 'C'],
  sell: ['售卖当前选中干员', 'X'], retreat: ['撤离当前干员', 'Q'], levelUp: ['升级等级', 'G'], pause: ['暂停/继续作战', '空格'],
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
    if (!code || !/^Key[A-Z]|^Digit[0-9]|^Space$|^Arrow/.test(code)) { setError('请使用字母、数字、方向键或空格'); return; }
    const other = Object.entries(shortcuts).find(([a, v]) => a !== action && v === code);
    if (other) { setError(`与“${SHORTCUT_LABELS[other[0]]?.[0] || other[0]}”重复`); return; }
    shortcutsStore.set({ [action]: code }); setEditing(null); setError('');
  };
  const reset = () => { shortcutsStore.set({ ...DEFAULT_SHORTCUTS }); setEditing(null); setError(''); };
  const display = (code) => code === 'Space' ? '空格' : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '方向');
  return html`<${Modal} open=${open} title="修改快捷键" micro="KEYBOARD SHORTCUTS" width="6.5rem" onClose=${onClose}
      actions=${html`<${Button} variant="secondary" icon="refresh" onClick=${reset}>重置默认<//><${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="shortcut-list">
      ${Object.entries(SHORTCUT_LABELS).map(([action, [label]]) => html`<div key=${action} class="shortcut-row">
        <span>${label}</span>
        ${editing === action
          ? html`<button ref=${listenRef} type="button" class="shortcut-key is-listening" onKeyDown=${(e) => setKey(action, e)}>请按键…</button>`
          : html`<button type="button" class="shortcut-key" onClick=${() => { setEditing(action); setError(''); }}>${display(shortcuts[action])}</button>`}
      </div>`)}
      ${error ? html`<p class="shortcut-error">${error}</p>` : html`<p class="set-hint">点击按键后，再按下要绑定的新键。重复按键会被拒绝。</p>`}
    </div>
  <//>`;
}
