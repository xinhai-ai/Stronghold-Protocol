export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export function createApiClient(t, fetcher = globalThis.fetch) {
  return async (path, options) => {
    let response;
    try { response = await fetcher(path, { ...options, cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(t('网络连接失败或超时，请稍后重试。')); }
    let payload;
    try { payload = await response.json(); } catch { /* Cloudflare limits/WAF may return HTML or plain text. */ }
    if (!response.ok) {
      const fallback = response.status === 429
        ? '留言服务暂时达到访问限制，请稍后再试。数据导出和清理仍可使用。'
        : '留言服务暂不可用';
      throw new ApiError(t(typeof payload?.error === 'string' ? payload.error : fallback), response.status);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(t('留言服务暂不可用'));
    return payload;
  };
}
export function submissionError(error, t) {
  if (error instanceof ApiError && error.status < 500) return error.message;
  return `${t(error.message)} ${t('若网络中断，留言可能已保存，请勿连续重复提交。')}`;
}
