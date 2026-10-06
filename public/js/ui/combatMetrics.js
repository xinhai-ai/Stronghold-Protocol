import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, useTicker } from './components.js';
import { UnitThumb } from './gameComponents.js';
import { battleRunner } from '../battle/runner.js';

const TYPES = Object.freeze([
  { id: 'phys', label: '物理' }, { id: 'arts', label: '法术' },
  { id: 'true', label: '真实' }, { id: 'elemental', label: '元素' },
]);
const number = (n) => Math.round(n || 0).toLocaleString('zh-CN');
const rate = (n) => (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });

/** A modeless panel: the battlefield stays visible and keeps playing. Mounted only while open. */
export function CombatMetricsPanel({ myId, players = [], onClose, runner = battleRunner }) {
  const [scope, setScope] = useState('battle');
  const [owner, setOwner] = useState(myId || '');
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  useTicker(250);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('.modal, .guide')) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const panel = panelRef.current;
    const corner = panel?.parentElement;
    const measure = () => panel?.style.setProperty('--combat-corner-height', `${corner?.getBoundingClientRect().height || 44}px`);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (corner) observer?.observe(corner);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const result = runner?.combatMetrics({ scope, ownerId: owner || null }) || { rows: [], damage: 0, healing: 0 };
  const maximum = Math.max(1, ...result.rows.map((r) => r.damage));
  const owners = new Map(players.map((p) => [p.playerId, p.name]));
  if (myId && !owners.has(myId)) owners.set(myId, '自己');
  return html`<section ref=${panelRef} id="combat-metrics-panel" class="combat-metrics brackets" role="dialog" aria-label="作战统计"
      onKeyDown=${(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}>
    <header class="combat-metrics__head">
      <div><span class="combat-metrics__micro">COMBAT ANALYSIS</span><h2>作战统计</h2></div>
      <button ref=${closeRef} type="button" class="combat-metrics__close" aria-label="关闭作战统计" onClick=${onClose}><${Icon} name="close" /></button>
    </header>
    <div class="combat-metrics__body">
    <div class="combat-metrics__tools">
      <div class="combat-metrics__scopes" role="group" aria-label="统计范围">
        ${[['battle', '当前战斗'], ['match', '本局累计']].map(([id, label]) => html`<button type="button" key=${id}
          aria-pressed=${scope === id} onClick=${() => setScope(id)}>${label}</button>`)}
      </div>
      <select aria-label="统计玩家" value=${owner} onChange=${(e) => setOwner(e.currentTarget.value)}>
        <option value="">全部玩家</option>
        ${[...owners].map(([id, name]) => html`<option key=${id} value=${id}>${id === myId ? '自己' : name}</option>`)}
      </select>
    </div>
    <div class="combat-metrics__totals">
      <span>总伤害 <b>${number(result.damage)}</b></span><span>总治疗 <b>${number(result.healing)}</b></span>
    </div>
    <div class="combat-metrics__legend" aria-label="伤害类型图例">
      ${TYPES.map((t) => html`<span key=${t.id} class=${`combat-metrics__type combat-metrics__type--${t.id}`}>${t.label}</span>`)}
      <span class="combat-metrics__sort">伤害降序</span>
    </div>
    <ol class="combat-metrics__list" tabindex="0" aria-label="干员伤害排行">
      ${result.rows.length ? result.rows.map((r, i) => {
        const description = TYPES.map((t) => `${t.label} ${number(r.types[t.id])}`).join('，');
        return html`<li key=${r.key} class="combat-metrics__row">
          <span class="combat-metrics__rank">${String(i + 1).padStart(2, '0')}</span>
          <${UnitThumb} kind=${r.kind === 'token' ? 'token' : 'chess'} id=${r.defId} showTier=${false} size="sm" />
          <div class="combat-metrics__unit">
            <div class="combat-metrics__name"><b title=${r.name}>${r.name || r.defId}</b>
              ${owner ? null : html`<small>${owners.get(r.ownerId) || '队友'}</small>`}</div>
            <div class="combat-metrics__bar" role="img" aria-label=${description} title=${description}>
              ${TYPES.map((t) => html`<span key=${t.id} class=${`combat-metrics__segment combat-metrics__segment--${t.id}`}
                style=${{ width: `${r.types[t.id] / maximum * 100}%` }}></span>`)}
            </div>
            <div class="combat-metrics__values">
              <span><small>伤害</small><b>${number(r.damage)}</b></span>
              <span><small>DPS</small><b>${rate(r.dps)}</b></span>
              <span class="combat-metrics__heal"><small>治疗</small><b>${number(r.healing)}</b></span>
              <span class="combat-metrics__heal"><small>HPS</small><b>${rate(r.hps)}</b></span>
            </div>
          </div>
        </li>`;
      }) : html`<li class="combat-metrics__empty">暂无本地战斗记录<br /><small>开始战斗后实时显示干员数据</small></li>`}
    </ol>
    <p class="combat-metrics__note">同名干员合并 · 实际扣血 / 有效治疗 · 召唤物计入所属干员<br />DPS / HPS 按所选玩家累计战斗秒数计算。仅含本机模拟的战斗，刷新后重新累计。</p>
    </div>
  </section>`;
}
