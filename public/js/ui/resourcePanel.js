// public/js/ui/resourcePanel.js — the 「离线资源」 row of the settings modal: the off-by-default switch of the optional
// preload (public/js/resources/index.js), plus progress, pause/continue and 「清理缓存」. All resources are cached in the
// browser (Cache Storage) and served by public/resource-sw.js, so a later match keeps its art while the network is slow
// or gone; nothing here runs while the switch is off (docs/ASSETS.md「Preload」).

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel } from './components.js';
import { formatBytes } from '../resources/common.js';
import { clearResources, pauseResources, resourceState, startResources, subscribeResources, syncResources } from '../resources/index.js';

function Bar({ st }) {
  const pct = st.totalBytes
    ? Math.min(100, Math.round((st.bytes / st.totalBytes) * 100))
    : st.wanted ? Math.min(100, Math.round((st.done / st.wanted) * 100)) : 0;
  return html`<div class="res-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
    <i style=${`width:${pct}%`}></i>
  </div>`;
}

/** @param {{ enabled: boolean, onChange: (v: boolean) => void }} props */
export function ResourceRow({ enabled, onChange }) {
  const [st, setSt] = useState(() => resourceState());
  useEffect(() => subscribeResources(setSt), []);
  useEffect(() => { syncResources(enabled).catch(() => {}); }, [enabled]);

  const busy = st.phase === 'download' || st.phase === 'checking';
  const counters = st.totalBytes != null && st.sized
    ? `${formatBytes(st.bytes)} / ${formatBytes(st.totalBytes)}`
    : (st.totalBytes != null ? `${formatBytes(st.totalBytes)}` : '');
  const detail = [
    st.tier1Total ? `必需 ${st.tier1Done}/${st.tier1Total}` : '',
    st.total ? `全部 ${st.done}/${st.total}` : '',
    counters,
  ].filter(Boolean).join(' · ');

  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">离线资源<${MicroLabel}>OFFLINE ASSETS<//></span>
      <button type="button" class=${`set-toggle${enabled ? ' is-on' : ''}`} role="switch" aria-checked=${enabled ? 'true' : 'false'}
        disabled=${st.supported ? null : 'disabled'} onClick=${() => onChange(!enabled)}><i></i><span>${enabled ? '开启' : '关闭'}</span></button>
    </div>
    ${enabled || st.done
      ? html`<div class="set-res__body">
          ${st.supported ? html`<${Bar} st=${st} />` : null}
          <div class="set-res__line">
            <span class="set-res__text">${st.message || (busy ? '正在后台预载…' : detail)}</span>
            ${detail && st.supported ? html`<span class="set-res__num num">${detail}</span>` : null}
          </div>
          ${st.supported
            ? html`<div class="set-res__actions">
                ${busy
                  ? html`<${Button} variant="secondary" icon="hourglass" onClick=${() => pauseResources()}>暂停<//>`
                  : html`<${Button} variant="secondary" icon="play" onClick=${() => startResources()}>继续下载<//>`}
                <${Button} variant="ghost" icon="refresh" onClick=${() => { void clearResources(); }}>清理缓存<//>
              </div>`
            : null}
          ${st.worker ? html`<p class="set-hint set-res__warn">${st.worker}</p>` : null}
          ${st.failed ? html`<p class="set-hint set-res__warn">${st.failed} 个文件未完成（下次继续时重试）</p>` : null}
        </div>`
      : html`<p class="set-hint">开启后会把对局需要的素材（字体、界面、立绘、小人、音效）保存到本机，进入战斗不再等待网络；关闭时一切照旧按需加载。需要 HTTPS。</p>`}
  </div>`;
}
