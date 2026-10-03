// public/js/ui/resourcePanel.js — the two faces of the optional preload (docs/ASSETS.md「Preload」):
//   * ResourceRow      — the 「离线资源」 row of the settings modal;
//   * ResourceLauncher — the compact pill the title screen shows in its bottom-right corner (the settings modal is only
//                        reachable inside a match, so the home screen needs its own way in).
// Both drive public/js/resources/index.js and render its state; nothing here runs while the switch is off.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, ProgressBar } from './components.js';
import { formatBytes } from '../resources/common.js';
import { clearResources, pauseResources, resourceState, startResources, subscribeResources, syncResources } from '../resources/index.js';

/**
 * `1.2 GiB / 2.4 GiB` when the server could size the files, `2.4 GiB` when it could not, '' when it knows nothing.
 * @param {any} st state from public/js/resources/index.js
 */
export function byteText(st) {
  const total = Number.isFinite(st.totalBytes) && st.totalBytes > 0 ? st.totalBytes : 0;
  if (!total) return '';
  const done = Number.isFinite(st.bytes) ? st.bytes : 0;
  return st.sizedTotal ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(total);
}

/** `必需 120/456 · 全部 800/3959 · 1.2 GiB / 2.4 GiB` */
export function detailText(st) {
  if (!st.total) return '';
  return [
    st.tier1Total ? `必需 ${st.tier1Done}/${st.tier1Total}` : '',
    `全部 ${st.done}/${st.total}`,
    byteText(st),
  ].filter(Boolean).join(' · ');
}

/** Percent cached: by bytes when every file has a size, by file count otherwise (0..100, for the progress bar). */
export function percent(st) {
  if (!st.total) return 0;
  const byBytes = st.totalBytes > 0 && st.sizedTotal === st.total;
  const pct = byBytes ? (st.bytes / st.totalBytes) * 100 : (st.done / Math.max(1, st.wanted || st.total)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const busy = (st) => st.phase === 'download' || st.phase === 'checking';

/** 暂停 / 继续下载 / 清理缓存 (+ 关闭预载 where the caller can turn the setting off). */
function ResourceActions({ st, onClose }) {
  return html`<div class="res-actions">
    ${busy(st)
      ? html`<${Button} variant="secondary" size="sm" icon="hourglass" onClick=${() => pauseResources()}>暂停<//>`
      : st.complete
        ? html`<${Button} variant="secondary" size="sm" icon="check" onClick=${() => { void clearResources(); }}>清理缓存<//>`
        : html`<${Button} variant="secondary" size="sm" icon="play" onClick=${() => startResources()}>继续下载<//>`}
    ${busy(st) || st.complete ? null : html`<button type="button" class="res-link" onClick=${() => { void clearResources(); }}>清理缓存</button>`}
    ${onClose ? html`<button type="button" class="res-link" onClick=${onClose}>关闭预载</button>` : null}
  </div>`;
}

/** @param {{ enabled: boolean, onChange: (v: boolean) => void }} props */
export function ResourceRow({ enabled, onChange }) {
  const [st, setSt] = useState(() => resourceState());
  useEffect(() => subscribeResources(setSt), []);
  useEffect(() => { syncResources(enabled).catch(() => {}); }, [enabled]);
  const detail = detailText(st);

  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">离线资源<${MicroLabel}>OFFLINE ASSETS<//></span>
      <button type="button" class=${`set-toggle${enabled ? ' is-on' : ''}`} role="switch" aria-checked=${enabled ? 'true' : 'false'}
        disabled=${!enabled && !st.supported ? 'disabled' : null} onClick=${() => onChange(!enabled)}><i></i><span>${enabled ? '开启' : '关闭'}</span></button>
    </div>
    ${enabled || st.done
      ? html`<div class="set-res__body">
          ${st.supported ? html`<${ProgressBar} size="sm" value=${percent(st)} max=${100} tone=${st.error ? 'amber' : 'mint'} />` : null}
          <div class="set-res__line">
            <span class="set-res__text">${st.message || (busy(st) ? '正在后台预载…' : detail)}</span>
            ${detail && st.supported ? html`<span class="set-res__num num">${detail}</span>` : null}
          </div>
          ${st.supported ? html`<${ResourceActions} st=${st} />` : null}
          ${st.worker ? html`<p class="set-hint set-res__warn">${st.worker}</p>` : null}
          ${st.failed ? html`<p class="set-hint set-res__warn">${st.failed} 个文件未完成（下次继续时重试）</p>` : null}
        </div>`
      : html`<p class="set-hint">开启后会把对局需要的素材（字体、界面、立绘、小人、音效）保存到本机，进入战斗不再等待网络；关闭时一切照旧按需加载。需要 HTTPS。</p>`}
  </div>`;
}

/**
 * The title-screen pill. Collapsed while off (one click starts the preload and writes the setting), expanded while on:
 * progress, what is left and the same 暂停 / 清理缓存 / 关闭预载 actions. A browser that cannot keep the resources
 * (plain-HTTP LAN) shows nothing at all unless the switch is already on.
 * @param {{ enabled: boolean, onChange: (v: boolean) => void }} props
 */
export function ResourceLauncher({ enabled, onChange }) {
  const [st, setSt] = useState(() => resourceState());
  useEffect(() => subscribeResources(setSt), []);
  useEffect(() => { syncResources(enabled).catch(() => {}); }, [enabled]);
  if (!enabled && !st.supported) return null;
  const detail = detailText(st);
  const state = !enabled ? '预载'
    : busy(st) ? `预载中 ${percent(st)}%`
      : st.complete ? '已保存'
        : st.error ? '未完成' : '已暂停';

  return html`<div class=${`res-pill${enabled ? ' is-on' : ''}`}>
    <button type="button" class="res-pill__head" disabled=${enabled ? 'disabled' : null}
      title=${enabled ? st.message || '离线资源已开启，可用下方按钮暂停或清理' : '把对局素材存到本机，进入战斗不再等待下载'}
      onClick=${() => { if (!enabled) onChange(true); }}>
      <span class="res-pill__label">离线资源<${MicroLabel}>OFFLINE ASSETS<//></span>
      <span class="res-pill__state">${state}</span>
    </button>
    ${enabled
      ? html`<div class="res-pill__body">
          ${st.supported ? html`<${ProgressBar} size="sm" value=${percent(st)} max=${100} tone=${st.error ? 'amber' : 'mint'} />` : null}
          <p class="res-pill__text">${st.message || detail || st.worker || '正在准备…'}</p>
          ${st.message && detail ? html`<p class="res-pill__text is-dim">${detail}</p>` : null}
          ${st.worker && st.message ? html`<p class="res-pill__text is-warn">${st.worker}</p>` : null}
          ${st.supported
            ? html`<${ResourceActions} st=${st} onClose=${() => onChange(false)} />`
            : html`<div class="res-actions"><button type="button" class="res-link" onClick=${() => onChange(false)}>关闭预载</button></div>`}
        </div>`
      : html`<p class="res-pill__hint">提前把对局素材存到本机，进入战斗不再等待下载</p>`}
  </div>`;
}
