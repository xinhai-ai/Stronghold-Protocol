// Player settings (BGM/SFX/voice volume, the voice dub 语音语言, mute, damage numbers, render quality, 文字大小, the
// shortcut keys): a tiny observable store persisted in localStorage (`sp.pref.settings`), applied to the audio manager
// and to the document on every change, plus the settings modal — which also holds the language switch (ui/lang.js; kept
// apart in `sp.pref.lang`; under it a note while the current language's pack is a machine translation,
// `_meta.machineTranslated`) and the 快捷键 section that rebinds the in-match shortcuts (the key map:
// ui/gameLogic/shortcuts.js; the community request 「快捷键可不可以自己设置」, the owner's decision of 2026-10-07) and
// 问题反馈, which copies the diagnostics of this page for a bug report (diag.js: the error log, this browser, optionally
// the battle on screen; nothing is uploaded). The lobby and the room open it from a 设置 button next to 玩法说明
// (SettingsButton, GitHub #238); the title screen and the match have their own gear.
//
// 文字大小 (textSize, applied by applyTextSize): the interface text root `--t` of css/theme.css — a phone clamps the
// layout root `1rem` at 40 px (theme.css), which left the .18rem body text at 7.2 CSS px while the browser's own font
// settings only inflate the glyphs inside fixed boxes (and page zoom is off: index.html's viewport, ui/device.js).
// Only font-size declarations read `--t`, so the board, the HUD bands the prep camera keeps clear and the detail
// card's side do not move — the field is sized from the host element's clientWidth (render/app.js).

import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref, store } from '../store.js';
import { sanitizeSettings, DEFAULT_SHORTCUTS, sanitizeShortcuts, shortcutLabel, VOICE_LANGS, TEXT_SIZES } from './gameLogic.js';
import { GIcon } from './gameComponents.js';
import { audio } from '../audio.js';
import { openGuide } from './guide.js';
import { detectFeatures } from './device.js';
import { ResourceRow } from './resourcePanel.js';
import { FRAME_RATES } from '../frameRate.js';
import { LangToggle, machineTranslationNote } from './lang.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { errorCount, currentBattle, diagnosticsText } from '../diag.js';
import { copyText } from './clipboard.js';

import { AnnouncementButton } from './announcement.js';
const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Settings store: { bgm, sfx, voice, muted, damageNumbers, quality, fpsLimit, preload, preloadOptional }. */
/** Settings store: { bgm, sfx, voice, voiceLang, voiceOverrides, muted, damageNumbers, quality, textSize, keys }. */
export const settingsStore = createStore(sanitizeSettings(loadPref('settings', null)));
export const shortcutsStore = createStore(sanitizeShortcuts(loadPref('shortcuts', DEFAULT_SHORTCUTS)));

/**
 * 设置 →「文字大小」: put the step on <html data-text> — css/theme.css turns it into the text root `--t`
 * (`:root[data-text="md"] { --t: … }`), which every readable font-size reads; no layout value does. The attribute
 * (not an inline style) keeps the default in the stylesheet: without it — no JavaScript, an old saved profile, a
 * value a future version dropped — the page is the design's own sizes. Values outside TEXT_SIZES fall back to 小.
 * @param {'sm'|'md'|'lg'|'xl'} v
 */
export function applyTextSize(v) {
  const el = globalThis.document?.documentElement;
  if (el) el.dataset.text = TEXT_SIZES.includes(v) ? v : 'sm';
}

settingsStore.subscribe((s) => {
  savePref('settings', sanitizeSettings(s));
  audio.setVolumes(s);
  audio.setVoiceLang(s.voiceLang, s.voiceOverrides);
  applyTextSize(s.textSize);
});
shortcutsStore.subscribe((s) => savePref('shortcuts', sanitizeShortcuts(s)));
audio.setVolumes(settingsStore.get());
audio.setVoiceLang(settingsStore.get().voiceLang, settingsStore.get().voiceOverrides);
// before the first render (main.js boot renders after its imports ran): the stored step is on screen without a flash
applyTextSize(settingsStore.get().textSize);

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
/**
 * 文字大小: one step of TEXT_SIZES (ui/gameLogic/settings.js) with its label — 小 is the design's own sizes, the others
 * raise the text root `--t` (css/theme.css) and with it every readable font-size; the board and the HUD's boxes stay.
 */
const TEXT_SCALES = [['sm', N_('小')], ['md', N_('中')], ['lg', N_('大')], ['xl', N_('特大')]];
/**
 * 语音语言: each dub named in its own language, like the interface language switch (ui/lang.js) — the owner's
 * 「中文 / 日本語」 (2026-10-08); VOICE_LANGS order.
 */
const VOICE_LANG_NAMES = { cn: '中文', jp: '日本語' }; // i18n-ignore
/** Where a report goes: the upstream issue tracker (shown as text the player can select; a link may open nothing). */
export const ISSUES_URL = 'https://github.com/sganggs/Stronghold-Protocol/issues';

/**
 * 问题反馈: copy the diagnostics of this page (diag.js) for a GitHub issue — the errors recorded since the page opened,
 * this browser and device, where the player is, and, switched on by default while a battle is on screen, that battle's
 * spec (the dev tools replay it). Player names, the room code and the token are replaced; nothing is uploaded. Laid out
 * like 快捷键 above it (a head with its button, a hint, the result line); the battle switch is the settings' Toggle, and
 * when the clipboard refuses (some in-app browsers), the report is shown selected in a box styled like 干员调配's 导出.
 */
/** The result line of 复制诊断信息, by outcome (msgids: translated when shown, so a language switch reaches it). */
const DIAG_NOTES = { copied: N_('已复制诊断信息，可以粘贴到 GitHub issue 中'), refused: N_('无法写入剪贴板，请手动复制下面的内容') };

function DiagSection() {
  const [attach, setAttach] = useState(true);
  const [note, setNote] = useState(null);       // 'copied' | 'refused' | null: the result line
  const [manual, setManual] = useState(null);   // the report, when the clipboard refused it
  const boxRef = useRef(null);
  // the box opens selected for a manual copy, scrolled to its first line (select() leaves it at the end)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (manual && el) { el.focus(); el.select(); el.scrollTop = 0; }
  }, [manual]);
  const n = errorCount();
  const battle = currentBattle();
  const copy = async () => {
    const text = diagnosticsText({ state: store.get(), settings: settingsStore.get(), attachBattle: attach && !!battle });
    const ok = await copyText(text);
    setManual(ok ? null : text);
    setNote(ok ? 'copied' : 'refused');
  };
  return html`<section class="set-diag" aria-labelledby="set-diag-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-diag-title">${t('问题反馈')}<${MicroLabel}>DIAGNOSTICS<//></span>
      <${Button} variant="ghost" size="sm" icon="copy" class="set-diag__copy" data-testid="diag-copy" onClick=${copy}>${t('复制诊断信息')}<//>
    </div>
    <p class="set-hint">${t('遇到问题时，复制诊断信息并粘贴到 GitHub issue 中，开发者就能看到出错时的情况。诊断信息只在本机生成，不会自动上传；玩家名和房间号会被替换。')}</p>
    <div class="set-diag__meta">
      <span class="set-diag__stat">${t('已记录的错误')}<b class=${cx('set-diag__count num', n > 0 && 'is-warn')} data-testid="diag-count">${n}</b></span>
      <span class="set-diag__url">${ISSUES_URL.replace(/^https:\/\//, '')}</span>
    </div>
    ${battle ? html`<${Toggle} label=${t('附上本场战斗')} micro="BATTLE DATA" value=${attach} onChange=${setAttach} />
      <p class="set-hint set-diag__battle-hint">${t('开发者可以用附上的战斗数据重现这场战斗。')}</p>` : null}
    ${note ? html`<p class=${cx('set-keys__note', note === 'refused' && 'is-warn')} role="status" aria-live="polite">${t(DIAG_NOTES[note])}</p>` : null}
    ${manual ? html`<textarea ref=${boxRef} class="set-diag__text" data-testid="diag-text" spellcheck=${false} readOnly
      aria-label=${t('诊断信息')} value=${manual}></textarea>` : null}
  </section>`;
}

/**
 * Settings modal.
 * @param {{ open: boolean, onClose: Function }} props
 */
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
      <div class="set-row">
        <span class="set-row__label">${t('语音语言')}<${MicroLabel}>VOICE LANGUAGE<//></span>
        <div class="set-seg" role="radiogroup" aria-label=${t('语音语言')} data-testid="voice-lang">
          ${VOICE_LANGS.map((id) => html`<button key=${id} type="button" role="radio" aria-checked=${s.voiceLang === id ? 'true' : 'false'}
            lang=${id === 'jp' ? 'ja' : 'zh'} class=${s.voiceLang === id ? 'is-on' : ''} onClick=${() => updateSettings({ voiceLang: id })}>${VOICE_LANG_NAMES[id]}</button>`)}
        </div>
      </div>
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
      <div class="set-row">
        <span class="set-row__label">${t('文字大小')}<${MicroLabel}>TEXT SIZE<//></span>
        <div class="set-seg set-textsize" role="radiogroup" aria-label=${t('文字大小')} data-testid="text-size">
          ${TEXT_SCALES.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.textSize === id ? 'true' : 'false'}
            class=${s.textSize === id ? 'is-on' : ''} onClick=${() => updateSettings({ textSize: id })}>${t(label)}</button>`)}
        </div>
      </div>
      <p class="set-hint set-textsize-note">${t('调整界面文字大小，棋盘保持原比例。')}</p>
      <${DiagSection} />
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

/**
 * The 设置 button of the lobby and the room (GitHub #238 — before it the settings were reachable only from the title
 * screen and a running match): the twin of the 玩法说明 button (ui/guide.js GuideButton), with the settings modal behind it
 * (mounted only while open). The same modal as the title screen's and the match's: nothing in it is match-only.
 * @param {{ class?: string, size?: 'sm'|'md'|'lg'|'xl', variant?: string, label?: string }} props
 */
export function SettingsButton({ class: cls, size = 'sm', variant = 'ghost', label = t('设置') }) {
  const [open, setOpen] = useState(false);
  return html`<${Button} variant=${variant} size=${size} class=${cx('settings-btn', cls)} onClick=${() => setOpen(true)}
      title=${t('设置')} aria-label=${t('设置')} data-testid="settings-btn"><${GIcon} name="gear" class="btn__icon" />${label}<//>
    ${open ? html`<${SettingsModal} open=${true} onClose=${() => setOpen(false)} />` : null}`;
}
