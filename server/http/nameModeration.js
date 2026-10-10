import { clientAddress, limitKeyOf, sanitizeName } from '../net.js';
import { ERR, NAME_MAX_LEN } from '../../shared/constants.js';
import { sendJson } from './common.js';

// POST, not query strings: do not leak usernames into URL/access logs. No CORS opt-in.
export function createNameModerationRoute({ moderation, trustProxy }) {
  return async (req, res, pathname) => {
    if (pathname !== '/api/name-moderation') return false;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST'); sendJson(req, res, 405, { allowed: false, code: ERR.BAD_MSG }); return true;
    }
    // Browsers must send same-origin JSON; cross-site forms cannot initiate backend checks.
    const origin = req.headers.origin;
    let originHost = null;
    try { if (origin) originHost = new URL(origin).host; } catch { /* reject below */ }
    if ((origin && originHost !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(req, res, 403, { allowed: false, code: ERR.BAD_MSG }); return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      sendJson(req, res, 415, { allowed: false, code: ERR.BAD_MSG }); return true;
    }
    const chunks = [];
    let bytes = 0, expired = false;
    const timer = setTimeout(() => { expired = true; req.destroy(); }, 5000);
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024) { sendJson(req, res, 413, { allowed: false, code: ERR.BAD_MSG }); req.resume(); return true; }
        chunks.push(chunk);
      }
    } catch {
      if (!res.destroyed) sendJson(req, res, expired ? 408 : 400, { allowed: false, code: ERR.BAD_MSG });
      return true;
    } finally { clearTimeout(timer); }
    let raw;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.name; } catch { /* invalid JSON */ }
    const name = typeof raw === 'string' && raw.length <= NAME_MAX_LEN ? sanitizeName(raw) : null;
    if (!name) { sendJson(req, res, 400, { allowed: false, code: ERR.BAD_MSG }); return true; }
    const { ip } = clientAddress(req, trustProxy);
    let result = { allowed: true };
    try {
      const reviewed = moderation ? await moderation.check(name, limitKeyOf(ip)) : result;
      if (reviewed?.allowed !== true && [ERR.NAME_REJECTED, ERR.BAD_MSG].includes(reviewed?.code)) result = { allowed: false, code: reviewed.code };
    } catch { /* Review service failed: quietly allow, with no client warning. */ }
    const status = result.allowed ? 200 : result.code === ERR.NAME_REJECTED ? 422 : 400;
    if (!res.destroyed) sendJson(req, res, status, result);
    return true;
  };
}
