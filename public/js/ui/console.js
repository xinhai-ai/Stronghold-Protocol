// In-match developer console. The server remains authoritative for permissions, data ids and quotas; this component
// only searches the already-loaded game data and sends one grant intent at a time.
import { useMemo, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, Modal, TextField, MicroLabel } from './components.js';
import { UnitThumb, useGameData } from './gameComponents.js';
import { actions } from './gameActions.js';
import { data } from '../data.js';
import { CONSOLE_ROUND_LIMIT, CONSOLE_TOTAL_LIMIT } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const idOf = (r, fallback = null) => r?.id || r?.chessId || r?.itemId || fallback;

/** Preserve ids stored as object-map keys. Some generated records intentionally omit their own id field. */
function dataRecords(name) {
  const raw = data.get(name);
  let source = raw;
  if (source && !Array.isArray(source) && typeof source === 'object') {
    for (const key of [name, 'list', 'data', 'records', 'entries']) {
      if (source[key] && typeof source[key] === 'object') { source = source[key]; break; }
    }
  }
  const seen = new Set();
  const out = [];
  if (Array.isArray(source)) {
    for (const r of source) {
      const id = idOf(r);
      if (id && !seen.has(id)) { seen.add(id); out.push({ ...r, id }); }
    }
  } else if (source && typeof source === 'object') {
    for (const [key, r] of Object.entries(source)) {
      const id = idOf(r, key);
      if (r && typeof r === 'object' && id && !seen.has(id)) { seen.add(id); out.push({ ...r, id }); }
    }
  }
  return out;
}

export function ConsoleModal({ open, priv, onClose }) {
  const gd = useGameData();
  const [kind, setKind] = useState('chess');
  const [query, setQuery] = useState('');
  const [selectedBond, setSelectedBond] = useState(null);
  const [bondAmountText, setBondAmountText] = useState('10');
  const [busy, setBusy] = useState(null);
  const q = query.trim().toLowerCase();
  const entries = useMemo(() => {
    if (!gd.ready) return [];
    const source = dataRecords(kind === 'chess' ? 'chess' : kind === 'item' ? 'items' : 'bonds');
    return source.filter((r) => {
      const id = idOf(r);
      if (!id || r.isDiy || r.isHidden) return false;
      if (kind === 'chess' && (!r.visible && !r.isGolden || r.isDiy || r.isHidden)) return false;
      const text = `${id} ${r.name || ''}`.toLowerCase();
      return !q || text.includes(q);
    }).sort((a, b) => (Number(a.tier) || 99) - (Number(b.tier) || 99) || String(a.name || idOf(a)).localeCompare(String(b.name || idOf(b))));
  }, [gd.ready, kind, q]);
  const roundUses = Number(priv?.console?.roundUses) || 0;
  const totalUses = Number(priv?.console?.totalUses) || 0;
  const roundLimit = Number(priv?.console?.roundLimit) || CONSOLE_ROUND_LIMIT;
  const totalLimit = Number(priv?.console?.totalLimit) || CONSOLE_TOTAL_LIMIT;
  const grant = async (grantKind, id, amount = null) => {
    if (busy || roundUses >= roundLimit || totalUses >= totalLimit) return false;
    setBusy(id);
    const ok = await actions.console(grantKind, id, amount);
    setBusy(null);
    return ok;
  };
  const openBond = (bond) => {
    setBondAmountText('10');
    setSelectedBond(bond);
  };
  const grantBond = async (amount) => {
    const n = Number(amount);
    if (!selectedBond || !Number.isInteger(n) || n <= 0) return false;
    const ok = await grant('bond', selectedBond.id, n);
    if (ok) setSelectedBond(null);
    return ok;
  };
  return html`<${Modal} open=${open} title=${t('控制台')} micro="DEVELOPER CONSOLE" tone="red" onClose=${onClose} width="8.6rem"
      actions=${html`<${Button} variant="secondary" icon="close" onClick=${onClose}>${t('关闭')}<//>`}>
    <div class="console-ui">
      <div class="console-ui__warning"><${Icon} name="warn" />${t('仅供必要时使用 · 每回合 {roundLimit} 次 · 全场 {totalLimit} 次', { roundLimit, totalLimit })}</div>
      <div class="console-ui__tabs" role="tablist">
        <${Button} size="sm" variant=${kind === 'chess' ? 'primary' : 'secondary'} icon="user" onClick=${() => setKind('chess')}>${t('干员')}<//>
        <${Button} size="sm" variant=${kind === 'item' ? 'primary' : 'secondary'} icon="shield" onClick=${() => setKind('item')}>${t('装备')}<//>
        <${Button} size="sm" variant=${kind === 'bond' ? 'primary' : 'secondary'} icon="users" onClick=${() => setKind('bond')}>${t('盟约层数')}<//>
        <span class="console-ui__quota num">${t('本回合 {roundUses}/{roundLimit} · 全场 {totalUses}/{totalLimit}', { roundUses, roundLimit, totalUses, totalLimit })}</span>
      </div>
      <${TextField} size="md" icon="search" value=${query} placeholder=${kind === 'chess' ? t('搜索干员名称或 ID') : kind === 'item' ? t('搜索装备名称或 ID') : t('搜索盟约名称或 ID')} onInput=${setQuery} />
      <div class="console-ui__list" role="list">
        ${entries.length ? entries.map((r) => {
          const id = idOf(r);
          return html`<button key=${id} type="button" class="console-ui__entry" disabled=${!!busy || roundUses >= roundLimit || totalUses >= totalLimit}
            onClick=${() => kind === 'bond' ? openBond({ ...r, id }) : grant(kind, id)}>
            ${kind === 'bond' ? html`<span class="console-ui__bond-icon"><${Icon} name="users" /></span>` : html`<${UnitThumb} kind=${kind} id=${id} tier=${r.tier} golden=${!!r.isGolden} size="sm" />`}
            <span class="console-ui__entry-text"><b>${r.name || id}</b><${MicroLabel}>${id}<//></span>
            ${busy === id ? html`<span class="console-ui__entry-busy">${t('发放中…')}</span>` : html`<${Icon} name="plus" />`}
          </button>`;
        }) : html`<p class="console-ui__empty">${gd.ready ? t('没有匹配的条目') : t('正在载入数据…')}</p>`}
      </div>
    </div>
    <${BondAmountModal} bond=${selectedBond} value=${bondAmountText} busy=${!!busy}
      onChange=${setBondAmountText} onPreset=${grantBond} onConfirm=${grantBond} onClose=${() => setSelectedBond(null)} />
  <//>`;
}

function BondAmountModal({ bond, value, busy, onChange, onPreset, onConfirm, onClose }) {
  if (!bond) return null;
  const amount = Number(value);
  const valid = Number.isInteger(amount) && amount > 0;
  return html`<${Modal} open=${true} title=${t('增加 {0} 层数', { 0: bond.name || bond.id })} micro="BOND LAYERS" tone="red"
      onClose=${onClose} width="4.8rem"
      actions=${html`<${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
        <${Button} variant="danger" icon="plus" loading=${busy} disabled=${!valid} onClick=${() => onConfirm(amount)}>${t('确定增加')}<//>`}>
    <div class="console-bond-modal">
      <label class="console-ui__amount">${t('增加层数')}
        <input type="number" min="1" step="1" value=${value} onInput=${(e) => onChange(e.currentTarget.value)} autofocus />
      </label>
      <div class="console-ui__presets">
        ${[10, 50, 100].map((n) => html`<${Button} key=${n} variant="secondary" size="sm" disabled=${busy} onClick=${() => onPreset(n)}>${t('{n} 层', { n })}<//>`)}
      </div>
      <p class="t-lo">${t('实际增加层数受盟约层数上限限制。')}</p>
    </div>
  <//>`;
}
