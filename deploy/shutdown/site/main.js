import './style.css';
import { exportData, clearResourceCaches, clearPersonalData } from './data.js';
import { createTurnstileLoader } from './turnstile.js';
import { selectLocale, createTranslator, applyTranslations } from './i18n.js';
import { createApiClient, submissionError } from './api.js';
const locale = selectLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
const t = createTranslator(locale);
applyTranslations(document, locale, t);
const $ = id => document.getElementById(id);
let dataBusy = false;
async function dataAction(action) {
  if (dataBusy) return;
  dataBusy = true;
  const buttons = document.querySelectorAll('#exports button, #clear-cache, #clear-personal');
  buttons.forEach(button => { button.disabled = true; });
  $('data-status').textContent = t('正在处理…');
  try { $('data-status').textContent = await action(); }
  catch (error) { $('data-status').textContent = t('操作失败：{error}', { error: t(error.message) }); }
  finally { dataBusy = false; buttons.forEach(button => { button.disabled = false; }); }
}
document.querySelectorAll('[data-export]').forEach(button => {
  button.addEventListener('click', () => dataAction(async () => {
    const kind = button.dataset.export;
    const payload = exportData(kind, localStorage);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `stronghold-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return t('已发起下载，请在浏览器下载列表中检查文件后再清理数据。');
  }));
});
$('clear-cache').onclick = () => {
  if (confirm(t('清除本游戏的素材缓存？战绩、配置与自选媒体会保留。请先关闭其他游戏页面。'))) {
    dataAction(async () => { const count = await clearResourceCaches(globalThis.caches); return t('已清理 {count} 个素材缓存。', { count }); });
  }
};
$('clear-personal').onclick = () => {
  if (confirm(t('永久删除本机战绩、成就、干员配置、所有偏好、自选背景与音乐？请确认已保存需要的备份。此操作不可撤销。'))) {
    dataAction(async () => { await clearPersonalData(localStorage, globalThis.indexedDB); return t('已删除本机战绩、偏好和自选媒体。'); });
  }
};
const api = createApiClient(t);
const loadTurnstile = createTurnstileLoader();
let token = '', widget, turnstileApi, submitting = false, verificationLoading = false;
function resetToken() { token = ''; $('submit').disabled = true; }
async function setupVerification() {
  if (verificationLoading || submitting) return;
  verificationLoading = true; resetToken();
  try {
    const { siteKey } = await api('/api/config');
    if (!siteKey || siteKey.startsWith('REPLACE_')) throw new Error(t('留言暂未开放'));
    turnstileApi = await loadTurnstile();
    if (widget !== undefined) turnstileApi.remove(widget);
    $('message-status').textContent = t('请完成人机验证后提交。');
    widget = turnstileApi.render('#turnstile-widget', {
      sitekey: siteKey, action: 'farewell', theme: 'dark', language: locale,
      callback(value) { token = value; $('submit').disabled = submitting; $('message-status').textContent = t('验证完成，可以提交留言。'); },
      'expired-callback': () => { resetToken(); $('message-status').textContent = t('验证已过期，请重新验证。'); },
      'error-callback': () => { resetToken(); $('message-status').textContent = t('验证失败，请重新加载验证。'); },
    });
  } catch (error) { $('message-status').textContent = t(error.message); }
  finally { verificationLoading = false; }
}
$('retry-verification').onclick = setupVerification;
$('message-form').onsubmit = async event => {
  event.preventDefault();
  if (!token || submitting) return;
  submitting = true; $('submit').disabled = true;
  const form = new FormData(event.currentTarget);
  $('message-status').textContent = t('正在提交…');
  try {
    await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.get('name'), body: form.get('body'), token }) });
    $('message-form').elements.body.value = '';
    $('message-status').textContent = t('留言已保存，感谢你的陪伴。');
  } catch (error) { $('message-status').textContent = submissionError(error, t); }
  finally { submitting = false; resetToken(); if (widget !== undefined) turnstileApi.reset(widget); }
};
let messagesInitialized = false;
$('message-option').addEventListener('toggle', () => {
  if (!$('message-option').open || messagesInitialized) return;
  messagesInitialized = true;
  setupVerification();
});
