// A named DOM element or a partially initialized SDK is not a usable Turnstile API.
const isReady = api => ['render', 'remove', 'reset'].every(method => typeof api?.[method] === 'function');

export function createTurnstileLoader(scope = globalThis) {
  let pending, attempt = 0;
  return function loadTurnstile() {
    if (isReady(scope.turnstile)) return Promise.resolve(scope.turnstile);
    if (pending) return pending;
    const promise = new Promise((resolve, reject) => {
      const script = scope.document.createElement('script');
      const callbackName = `spFarewellTurnstileReady${++attempt}`;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        scope.clearTimeout(timer);
        delete scope[callbackName];
        script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(scope.turnstile);
      };
      scope[callbackName] = () => finish(isReady(scope.turnstile) ? null : new Error('人机验证初始化失败，请重新加载验证'));
      // The SDK onload parameter signals API readiness; the script's load event does not.
      script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${callbackName}`;
      script.async = true;
      script.onerror = () => finish(new Error('无法加载人机验证，请重新加载验证'));
      const timer = scope.setTimeout(() => finish(new Error('人机验证加载超时，请重新加载验证')), 15000);
      scope.document.head.append(script);
    });
    pending = promise;
    const clearPending = () => { if (pending === promise) pending = undefined; };
    promise.then(clearPending, clearPending);
    return promise;
  };
}
