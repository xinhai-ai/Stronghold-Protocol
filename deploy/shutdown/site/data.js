import { migrateStats, exportStats, STATS_VERSION } from '../../../public/js/ui/stats.js';
import { parseStored, parseStoredOps, exportPayload, LOADOUT_VERSION } from '../../../public/js/ui/loadoutModel.js';

export function preferenceBackup(storage) {
  const values = Object.create(null);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith('sp.pref.')) values[key] = storage.getItem(key);
  }
  return { app: 'stronghold-protocol', kind: 'preferences-backup', v: 1, exportedAt: new Date().toISOString(), values };
}
export function exportData(kind, storage) {
  const key = kind === 'stats' ? 'sp.pref.stats' : kind === 'loadout' ? 'sp.pref.loadout' : null;
  if (!key) throw new Error('未知导出类型');
  const text = storage.getItem(key);
  if (!text) throw new Error('当前浏览器没有这类数据');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('数据格式损坏，无法导出'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('数据格式无效，无法导出');
  if (kind === 'stats') {
    if (raw.v > STATS_VERSION) throw new Error('统计来自更新版本，请使用对应版本的游戏导出');
    if (!Array.isArray(raw.records)) throw new Error('统计格式无效，无法导出');
    const migrated = migrateStats(raw);
    if (migrated.dropped) throw new Error('统计包含无法识别的记录，无法完整导出');
    return exportStats(migrated.stats);
  }
  if (raw.v > LOADOUT_VERSION) throw new Error('配置来自更新版本，请使用对应版本的游戏导出');
  return exportPayload(parseStored(raw), { ops: parseStoredOps(raw) });
}
export async function clearResourceCaches(cacheStorage) {
  if (!cacheStorage) throw new Error('浏览器不支持缓存管理，请在浏览器设置中清理');
  const names = (await cacheStorage.keys()).filter(name => name.startsWith('stronghold-resources-v1-'));
  for (const name of names) await cacheStorage.delete(name);
  return names.length;
}
export function deleteMediaDatabase(name, indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('媒体存储被其他页面占用；关闭其他游戏页面后重试，部分数据可能已删除'));
  });
}
export async function clearPersonalData(storage, indexedDB) {
  const keys = Object.keys(preferenceBackup(storage).values);
  // Delete media first, so blocked databases do not erase the user's JSON backups first.
  if (!indexedDB) throw new Error('浏览器不支持媒体清理，请使用浏览器设置');
  for (const name of ['sp-hub-backdrop', 'sp-lobby-music']) await deleteMediaDatabase(name, indexedDB);
  for (const key of keys) storage.removeItem(key);
}
