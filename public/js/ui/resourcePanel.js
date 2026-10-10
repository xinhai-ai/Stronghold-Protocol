// Compact entry points share one global resource manager; closing it leaves background downloads running.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal, ProgressBar } from './components.js';
import { createStore, useStore } from '../store.js';
import { formatBytes, PRELOAD_VOICE_LANGS } from '../resources/common.js';
import { clearResources, exportResources, importResources, inspectResources, pauseResources,
  resourceState, startResources, subscribeResources } from '../resources/index.js';
import { t, N_ } from '../../../shared/i18n.js';

const PRELOAD_VOICE_LABELS = { cn: N_('中文语音'), jp: N_('日语语音'), all: N_('两种语言'), none: N_('不预载语音') };

const RESOURCE_DOWNLOAD_URL = 'https://t.bilibili.com/1256354225629167619';

export function byteText(st) {
  if (Number.isFinite(st.selectedWanted)) {
    if (!st.selectedTotalBytes) return '';
    return st.selectedUnknownSize ? formatBytes(st.selectedTotalBytes)
      : `${formatBytes(st.selectedBytes)} / ${formatBytes(st.selectedTotalBytes)}`;
  }
  const total = Number.isFinite(st.totalBytes) && st.totalBytes > 0 ? st.totalBytes : 0;
  if (!total) return '';
  const done = Number.isFinite(st.bytes) ? st.bytes : 0;
  return st.sizedTotal ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(total);
}

export function detailText(st) {
  if (Number.isFinite(st.selectedWanted)) return [t('所选 {done}/{total}', { done: st.selectedDone, total: st.selectedWanted }), byteText(st)].filter(Boolean).join(' · ');
  if (!st.total) return '';
  return [st.tier1Total ? t('必需 {tier1Done}/{tier1Total}', { tier1Done: st.tier1Done, tier1Total: st.tier1Total }) : '', t('全部 {done}/{total}', { done: st.done, total: st.total }), byteText(st)].filter(Boolean).join(' · ');
}

export function percent(st) {
  if (Number.isFinite(st.selectedWanted)) {
    if (!st.selectedWanted) return 0;
    const pct = st.selectedUnknownSize === 0 && st.selectedTotalBytes > 0
      ? st.selectedBytes / st.selectedTotalBytes : st.selectedDone / st.selectedWanted;
    return Math.max(0, Math.min(100, Math.round(pct * 100)));
  }
  if (!st.total) return 0;
  const byBytes = st.totalBytes > 0 && st.sizedTotal === st.total;
  const pct = byBytes ? (st.bytes / st.totalBytes) * 100 : (st.done / Math.max(1, st.wanted || st.total)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const resourceUi = createStore({ open: false });
export const openResources = () => resourceUi.set({ open: true });
const closeResources = () => resourceUi.set({ open: false });
const busy = (st) => !!st.archive || st.phase === 'download' || st.phase === 'checking';

function useResources() {
  const [state, setState] = useState(resourceState);
  useEffect(() => subscribeResources(setState), []);
  return state;
}

function stateText(st, enabled) {
  if (st.archive) return st.archive === 'import' ? t('正在导入') : t('正在导出');
  if (st.phase === 'foreign') return t('另一标签页处理中');
  if (busy(st)) return t('处理中');
  if (st.complete) return t('全部已保存');
  if (st.selectionComplete && st.tier1Total) return st.optional ? t('所选资源已齐全。') : t('必备已保存');
  return enabled ? t('已暂停') : t('未开启');
}

export function ResourceRow({ enabled }) {
  const st = useResources();
  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <${Button} variant="secondary" size="sm" icon="expand" onClick=${openResources}>${t('资源管理')}<//>
    </div>
    <p class="set-hint">${stateText(st, enabled)} ${t('· 管理必备与可选资源，或导入、导出 ZIP 资源包。')}</p>
  </div>`;
}

export function ResourceLauncher({ enabled }) {
  const st = useResources();
  return html`<div class=${`res-pill${enabled ? ' is-on' : ''}`}>
    <button type="button" class="res-pill__head" title=${t('管理预载资源和 ZIP 资源包')} onClick=${openResources}>
      <span class="res-pill__label">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <span class="res-pill__state">${stateText(st, enabled)}</span>
    </button>
    <p class="res-pill__hint">${t('必备 / 可选资源 · ZIP 导入与导出')}</p>
  </div>`;
}

function ResourceTier({ st, tier, optional, onOptional, voiceLang, onVoiceLang, disabled }) {
  const groups = st.groups.filter((g) => g.tier === tier);
  const chosen = groups.filter((g) => g.selected !== false);
  const total = chosen.reduce((n, g) => n + g.wanted, 0);
  const done = chosen.reduce((n, g) => n + g.present, 0);
  const bytes = chosen.reduce((n, g) => n + g.bytes, 0);
  const totalBytes = chosen.reduce((n, g) => n + g.totalBytes, 0);
  const unknown = chosen.some((g) => g.unknownSize);
  return html`<section class="resource-tier">
    <header class="resource-tier__head">
      <div><h3>${tier === 1 ? t('必备资源') : t('可选资源')}</h3>
        <p>${tier === 1 ? t('地图、干员图片与 Spine 等画面资源') : t('角色语音、音效、背景音乐与玩法说明图片')}</p></div>
      ${tier === 2 ? html`<label class="resource-choice"><input type="checkbox" checked=${optional} disabled=${disabled}
        onChange=${(e) => onOptional(e.currentTarget.checked)} />${t('同时预载')}</label>` : html`<${MicroLabel}>REQUIRED<//>`}
    </header>
    ${tier === 2 ? html`<fieldset class="resource-voice-choice" disabled=${disabled}>
      <legend>${t('预载语音语言')}</legend>
      <div class="resource-voice-choice__options" role="radiogroup" aria-label=${t('预载语音语言')} data-testid="preload-voice-lang">
        ${PRELOAD_VOICE_LANGS.map((lang) => html`<label class="resource-choice" key=${lang}>
          <input type="radio" name="preload-voice-lang" value=${lang} checked=${voiceLang === lang}
            onChange=${() => onVoiceLang(lang)} />${t(PRELOAD_VOICE_LABELS[lang])}</label>`)}
      </div>
      <p>${t('仅影响预载范围；播放语言仍在设置中选择。切换后保留已有缓存。')}</p>
      ${!optional ? html`<p>${t('勾选“同时预载”后下载所选语音。')}</p>` : null}
    </fieldset>` : null}
    <div class="resource-tier__summary"><span class="num">${t('{done} / {total} 个文件', { done, total })}</span>
      <span class="num">${unknown ? t('部分大小未知') : `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`}</span></div>
    <${ProgressBar} value=${done} max=${Math.max(1, total)} size="sm" tone=${tier === 1 ? 'mint' : 'amber'} />
    <ul class="resource-tier__list">
      ${groups.map((group) => html`<li key=${group.id}
        class=${st.archivePhase === 'import' && st.archiveGroup === group.id ? 'is-importing' : group.selected === false ? 'is-unselected' : ''}><span>${t(group.name)}
          ${group.selected === false ? html`<small>${t('未选择')}</small>` : null}
          ${st.archivePhase === 'import' && st.archiveGroup === group.id ? html`<small>${t('正在导入')}</small>` : null}</span>
        <span class="num">${group.present}/${group.wanted}</span>
        <span class="num">${group.unknownSize ? t('大小待确认') : formatBytes(group.totalBytes)}</span></li>`)}
    </ul>
  </section>`;
}

/** Mounted once in main.js, above all screens including the settings modal. */
export function ResourceHost({ enabled, optional, voiceLang = 'cn', onVoiceLang, onChange, onOptional }) {
  const { open } = useStore((s) => s, Object.is, resourceUi);
  const st = useResources();
  const fileInput = useRef(null);
  useEffect(() => { if (open) void inspectResources().catch(() => {}); }, [open]);
  const archiveBusy = !!st.archive;
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try { await importResources(file, { onImported: () => onChange(true) }); } catch { /* controller displays the error */ }
  };
  const exportFile = async () => {
    try {
      const { blob, version } = await exportResources();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stronghold-resources-${version.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* controller displays the error */ }
  };
  return html`<${Modal} open=${open} onClose=${closeResources} title=${t('预载资源管理')} micro="RESOURCE MANAGER" class="resource-modal"
    actions=${html`
      ${busy(st) ? html`<${Button} variant="secondary" icon="hourglass" onClick=${pauseResources}>${archiveBusy ? t('取消处理') : t('暂停下载')}<//>`
        : html`<${Button} variant="primary" icon="play" disabled=${!st.supported}
          onClick=${() => enabled ? startResources() : onChange(true)}>${st.selectionComplete ? t('检查资源') : enabled ? t('继续下载') : t('开始预载')}<//>`}
      <${Button} variant="secondary" onClick=${closeResources}>${t('关闭')}<//>`}>
    <div class="resource-manager">
      <p class="resource-manager__intro">${t('先预载必备资源；可选资源可按需加载。关闭此窗口后，下载会在后台继续。')}</p>
      <div class="resource-manager__tiers">
        <${ResourceTier} st=${st} tier=${1} />
        <${ResourceTier} st=${st} tier=${2} optional=${optional} onOptional=${onOptional} voiceLang=${voiceLang} onVoiceLang=${onVoiceLang} disabled=${archiveBusy} />
      </div>
      <p class=${`resource-manager__status${st.error ? ' is-error' : ''}`} role="status" aria-live="polite">
        ${st.message || (enabled ? t('预载已开启') : t('选择下载范围，然后开始预载；也可以直接导入资源包。'))}</p>
      ${st.worker ? html`<p class="resource-manager__warn">${st.worker}</p>` : null}
      ${st.failed ? html`<p class="resource-manager__warn">${t('{failed} 个文件下载失败，继续下载时重试。', { failed: st.failed })}</p>` : null}
      ${st.skipped ? html`<p class="resource-manager__warn">${t('{skipped} 个文件超过单文件缓存上限，使用时按需加载。', { skipped: st.skipped })}</p>` : null}
      <section class="resource-archive">
        <h3>${t('ZIP 资源包')}</h3>
        <p>${t('可将已缓存的资源导出为 ZIP 并发送给朋友，也可以前往我的动态下载资源包。支持导入旧版本资源包；导入会校验完整性，只复用当前版本仍有效的文件，并增量下载缺少的资源。')}</p>
        ${st.archive ? html`<${ProgressBar} value=${st.archivePercent} max=${100} size="sm" tone="mint" />` : null}
        <input ref=${fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange=${importFile} />
        <div class="res-actions">
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported} onClick=${() => fileInput.current?.click()}>${t('导入 ZIP')}<//>
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported || !st.done} onClick=${exportFile}>${t('导出 ZIP')}<//>
          <${Button} variant="secondary" icon="link" disabled=${!RESOURCE_DOWNLOAD_URL}
            title=${RESOURCE_DOWNLOAD_URL ? t('前往我的动态下载资源包') : t('下载链接待补充')}
            onClick=${() => window.open(RESOURCE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}>${t('前往下载')}<//>
        </div>
      </section>
      <div class="resource-manager__maintenance">
        <button type="button" class="res-link" disabled=${archiveBusy} onClick=${() => { void clearResources(); }}>${t('清理缓存')}</button>
        ${enabled ? html`<button type="button" class="res-link" onClick=${() => onChange(false)}>${t('关闭预载')}</button>` : null}
        <span>${t('关闭预载会保留已缓存资源。')}</span>
      </div>
    </div>
  <//>`;
}
