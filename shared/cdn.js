/** Rewrite only root-relative asset URLs. Absolute URLs stay intact, including manifests already rewritten by a server. */
export function rewriteAssetPaths(value, base) {
  if (!base || value === null || typeof value !== 'object') return value;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.startsWith('/assets/')) value[key] = base + entry;
    else if (entry !== null && typeof entry === 'object') rewriteAssetPaths(entry, base);
  }
  return value;
}
