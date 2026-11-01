const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export async function ipHash(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BAD_BODY');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error('TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(await new Blob(chunks).text());
}
export async function handle(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/api/config' && request.method === 'GET') {
    return json({ siteKey: env.TURNSTILE_SITE_KEY || '' });
  }
  if (url.pathname === '/api/messages' && request.method === 'POST') {
    if (!env.SITE_ORIGIN || request.headers.get('Origin') !== env.SITE_ORIGIN) return json({ error: '请求来源无效' }, 403);
    if (!env.TURNSTILE_SECRET_KEY || !env.IP_HASH_SECRET || !env.DB) return json({ error: '留言暂未开放' }, 503);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return json({ error: '无法确认请求地址' }, 403);
    let input;
    try { input = await readBody(request); } catch { return json({ error: '请求格式无效或超过大小限制' }, 400); }
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const body = typeof input?.body === 'string' ? input.body.trim() : '';
    if (!name || name.length > 24 || !body || body.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name + body)
      || typeof input.token !== 'string' || !input.token || input.token.length > 2048) return json({ error: '请填写昵称、1–500 字留言并完成人机验证' }, 400);
    let verification;
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: input.token, remoteip: ip }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('VERIFY_UNAVAILABLE');
      verification = await response.json();
    } catch { return json({ error: '验证服务暂不可用，请重试' }, 503); }
    if (verification.success !== true || verification.hostname !== new URL(env.SITE_ORIGIN).hostname || verification.action !== 'farewell') {
      return json({ error: '人机验证失败或已过期，请重新验证' }, 403);
    }
    const hash = await ipHash(ip, env.IP_HASH_SECRET);
    try {
      await env.DB.prepare('INSERT INTO messages (ip_hash, name, body) VALUES (?, ?, ?)').bind(hash, name, body).run();
    } catch (error) {
      if (String(error.message).includes('IP_QUOTA')) return json({ error: '此 IP 已提交 5 条留言，感谢你的陪伴' }, 429);
      throw error;
    }
    return json({ ok: true }, 201);
  }
  if (url.pathname.startsWith('/api/')) return json({ error: '接口不存在或请求方法不支持' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  // Keep old bookmarks useful; do not route API, assets or WebSocket requests to HTML.
  if (url.pathname === '/ws') return new Response('Server closed', { status: 410 });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // ASSETS applies HTML canonicalization even for binding fetches:
    // requesting /index.html redirects to /, so fetch the canonical root directly.
    url.pathname = '/';
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return json({ error: '服务暂不可用，请稍后重试' }, 503); }
  },
};
