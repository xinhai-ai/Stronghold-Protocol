// Browser-only, read-only combat accounting. No event history or network payloads.
export const DAMAGE_TYPES = Object.freeze(['phys', 'arts', 'true', 'elemental']);
const positive = (n) => Number.isFinite(n) && n > 0 ? n : 0;

function operatorOf(source) {
  const seen = new Set();
  while (source && source.kind === 'token' && source.ownerUnit && !seen.has(source)) {
    seen.add(source);
    source = source.ownerUnit;
  }
  return source?.side === 'ally' && source.ownerId != null && (source.kind === 'op' || source.kind === 'token') ? source : null;
}

/** Attach before the first tick, including silent catch-up. The simulation's own counters define effective HP loss. */
export function trackCombat(battle) {
  const rows = new Map();
  const damageMarks = new WeakMap();
  for (const u of battle.allyUnits || []) damageMarks.set(u, positive(u.stats?.dmg));
  function rowOf(source) {
    const u = operatorOf(source);
    if (!u) return null;
    const key = JSON.stringify([u.ownerId, u.uid != null ? `uid:${u.uid}` : `unit:${u.id}:${u.defId}`]);
    if (!rows.has(key)) rows.set(key, {
      key, ownerId: u.ownerId, uid: u.uid, defId: u.defId, name: u.name, kind: u.kind,
      damage: 0, healing: 0, types: Object.fromEntries(DAMAGE_TYPES.map((t) => [t, 0])),
    });
    return rows.get(key);
  }
  for (const u of battle.allyUnits || []) rowOf(u);
  // Runs before gameplay damaged handlers can cause nested damage. This also sees loseHp and silent DoT.
  // Element gauge fill changes stats.elem, never stats.dmg, so it cannot inflate HP damage.
  battle.on('damaged', ({ source, credit, type }) => {
    const src = credit || source;
    if (!src || src.side !== 'ally') return;
    const total = positive(src.stats?.dmg);
    const delta = positive(total - (damageMarks.get(src) || 0));
    damageMarks.set(src, total);
    const row = rowOf(src);
    if (!row || !delta) return;
    row.damage += delta;
    row.types[DAMAGE_TYPES.includes(type) ? type : 'true'] += delta;
  }, { priority: Number.MAX_VALUE });
  // The heal hook is before mitigation/overheal. The return value is the actual restored HP, including silent regen.
  const heal = battle.heal;
  battle.heal = function (source, target, amount, opts) {
    const actual = heal.call(this, source, target, amount, opts);
    if (target?.side === 'ally' && positive(actual)) {
      const row = rowOf(source);
      if (row) row.healing += actual;
    }
    return actual;
  };
  return () => ({
    seconds: positive(battle.time),
    owners: (battle.players || []).map((p) => p.playerId),
    rows: [...rows.values()].map((r) => ({ ...r, types: { ...r.types } })),
  });
}

/** Replace each battle's snapshot by ID: switching fields / replaying an evicted replica never adds it twice. */
export function combineCombat(records, ownerId = null) {
  const rows = new Map();
  const elapsed = new Map();
  for (const record of records) {
    const owners = new Set((record.owners || []).filter((id) => ownerId == null || id === ownerId));
    for (const r of record.rows) {
      if (ownerId != null && r.ownerId !== ownerId) continue;
      owners.add(r.ownerId);
      // Keep per-piece records in the collector, but display same-name units together for each player.
      // Distinct definitions (including promoted copies) with the same display name share one row.
      const key = JSON.stringify([r.ownerId, r.kind, r.name || r.defId]);
      let row = rows.get(key);
      if (!row) {
        row = { ...r, key, damage: 0, healing: 0, types: Object.fromEntries(DAMAGE_TYPES.map((t) => [t, 0])) };
        rows.set(key, row);
      }
      // Use the latest encountered definition for the combined row's portrait.
      Object.assign(row, { defId: r.defId, name: r.name, kind: r.kind });
      row.damage += r.damage;
      row.healing += r.healing;
      for (const t of DAMAGE_TYPES) row.types[t] += r.types[t] || 0;
    }
    for (const owner of owners) elapsed.set(owner, (elapsed.get(owner) || 0) + positive(record.seconds));
  }
  const list = [...rows.values()].map((r) => {
    const seconds = elapsed.get(r.ownerId) || 0;
    return { ...r, seconds, dps: seconds > 0 ? r.damage / seconds : 0, hps: seconds > 0 ? r.healing / seconds : 0 };
  }).sort((a, b) => b.damage - a.damage || b.healing - a.healing || a.key.localeCompare(b.key));
  return { rows: list, damage: list.reduce((n, r) => n + r.damage, 0), healing: list.reduce((n, r) => n + r.healing, 0) };
}
