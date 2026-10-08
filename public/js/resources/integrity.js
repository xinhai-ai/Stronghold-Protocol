import { MAX_FILE_BYTES } from './common.js';

const verifiedResources = new WeakMap();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function resourceDigests(bytes, { legacy = false } = {}) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持资源校验');
  const sha256 = legacy ? hex(await crypto.subtle.digest('SHA-256', bytes)) : undefined;
  const sha1 = hex(await crypto.subtle.digest('SHA-1', bytes));
  return { sha1, hash: sha1.slice(0, 12), ...(legacy ? { sha256 } : {}) };
}

/** The caller owns these bytes exclusively and must not mutate them after verification. */
export async function verifyResourceBytes(bytes, expected, version = 1) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) throw new Error('资源大小无效');
  if (version !== 1 && version !== 2) throw new Error('资源包清单格式不受支持');
  const digest = await resourceDigests(bytes, { legacy: version === 1 });
  if (digest.hash !== expected.hash || (version === 1 ? digest.sha256 !== expected.sha256 : digest.sha1 !== expected.sha1)) {
    throw new Error('资源包校验失败');
  }
  const proof = Object.freeze({});
  verifiedResources.set(proof, { bytes, hash: digest.hash });
  return proof;
}

/** Only locally issued verification results can authorize a write; ZIP metadata cannot fabricate them. */
export function verifiedResourceBytes(proof, expectedHash) {
  const verified = verifiedResources.get(proof);
  return verified?.hash === expectedHash ? verified.bytes : null;
}
