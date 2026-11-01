import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectLocale, createTranslator, applyTranslations, messages, locales } from '../deploy/shutdown/site/i18n.js';
import { createApiClient, ApiError, submissionError } from '../deploy/shutdown/site/api.js';

test('browser language preferences select the first supported locale', () => {
  for (const [preferences, expected] of [
    [['en-US', 'zh-CN'], 'en'], [['de-DE', 'ja-JP', 'en-US'], 'ja'],
    [['fr-FR', 'ko-KR'], 'ko'], [['zh-SG'], 'zh-CN'], [['zh'], 'zh-CN'],
    [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'],
    [['zh-Hant-CN'], 'zh-TW'], [['zh-Hans-TW'], 'zh-CN'],
    [['ZH_hant_HK'], 'zh-TW'], [['invalid_tag_!', null, 'en-GB'], 'en'],
    [['de-DE'], 'en'], [[], 'en'], [undefined, 'en'], ['ja-JP', 'ja'],
  ]) assert.equal(selectLocale(preferences), expected);
});

test('all visible labels/placeholders and known runtime errors have complete translations', () => {
  const page = readFileSync(new URL('../deploy/shutdown/site/index.html', import.meta.url), 'utf8');
  const keys = [...page.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map(match => match[1]);
  for (const file of ['main.js', 'data.js', 'turnstile.js', 'api.js', '../worker.js']) {
    const source = readFileSync(new URL(`../deploy/shutdown/site/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:new Error\(|t\(|error:\s*)'([^']*\p{Script=Han}[^']*)'/gu)) keys.push(match[1]);
  }
  assert.ok(keys.length > 40);
  for (const key of keys) assert.ok(Object.hasOwn(messages, key), `missing message: ${key}`);
  for (const [key, translations] of Object.entries(messages)) {
    assert.equal(translations.length, locales.length - 1, key);
    const placeholders = key.match(/\{\w+\}/g) || [];
    for (const text of translations) {
      assert.equal(typeof text, 'string'); assert.ok(text.trim(), key);
      assert.deepEqual(text.match(/\{\w+\}/g) || [], placeholders, key);
    }
  }
});

test('translation interpolates values and applies labels as plain text, preserving nested layout', () => {
  const t = createTranslator('en');
  assert.equal(t('已清理 {count} 个素材缓存。', { count: 3 }), 'Cleared 3 asset cache(s).');
  assert.equal(createTranslator('zh-CN')('昵称'), '昵称');
  const label = { dataset: { i18n: '昵称' } };
  const placeholder = { dataset: { i18nPlaceholder: '如何称呼你' }, setAttribute(name, text) { this[name] = text; } };
  const document = { documentElement: {}, querySelectorAll: selector => selector === '[data-i18n]' ? [label] : [placeholder] };
  applyTranslations(document, 'en', t);
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(label.textContent, 'Nickname');
  assert.equal(placeholder.placeholder, 'What should we call you?');
  assert.match(t('操作失败：{error}', { error: '<script>example</script>' }), /<script>example<\/script>/);
});

test('server rejections and loader errors translate in every supported language', async () => {
  for (const locale of locales) {
    const t = createTranslator(locale);
    const api = createApiClient(t, async () => Response.json({ error: '请求来源无效' }, { status: 403 }));
    await assert.rejects(api('/api/messages'), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(submissionError(error, t), t('请求来源无效'));
      return true;
    });
    assert.ok(t('无法加载人机验证，请重新加载验证'));
  }
});

test('non-JSON rate limits show a translated limit message; IP quota responses retain their own message', async () => {
  const t = createTranslator('en');
  const limit = createApiClient(t, async () => new Response('<html>limit reached</html>', { status: 429 }));
  await assert.rejects(limit('/api/config'), error => {
    assert.equal(error.status, 429);
    assert.match(error.message, /access limit/);
    assert.doesNotMatch(submissionError(error, t), /already be saved/);
    return true;
  });
  const quota = createApiClient(t, async () => Response.json({ error: '此 IP 已提交 5 条留言，感谢你的陪伴' }, { status: 429 }));
  await assert.rejects(quota('/api/messages'), /already sent 5 messages/);
});

test('network failures and invalid successful responses have readable localized errors', async () => {
  const t = createTranslator('ja');
  const offline = createApiClient(t, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(offline('/api/messages'), error => {
    assert.equal(error.message, t('网络连接失败或超时，请稍后重试。'));
    assert.ok(submissionError(error, t).includes(t('若网络中断，留言可能已保存，请勿连续重复提交。')));
    return true;
  });
  const invalid = createApiClient(t, async () => new Response('<html>unexpected</html>'));
  await assert.rejects(invalid('/api/config'), error => error.message === t('留言服务暂不可用'));
});
