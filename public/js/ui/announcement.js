import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Button, Modal, useTicker } from './components.js';
import { createStore, store, useStore, loadPref, savePref } from '../store.js';
import { net } from '../net.js';
import { announcementLive } from '../../../shared/announcements.js';
import { PHASE } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

/** Constant pixel speed for long and short notices; the animation travels across the measured viewport. */
export function announcementScroll(viewport, textWidth) {
  const distance = Math.max(0, viewport) + Math.max(0, textWidth);
  return { from: Math.max(0, viewport), to: -Math.max(0, textWidth), duration: Math.max(8, distance / 70) };
}

export function announcementDismissKey(notice) {
  if (!notice) return '';
  const key = `${notice.type === 'popup' ? 'popup:' : ''}${notice.id}:${notice.startAt}:${notice.endAt}:${notice.text}`;
  return notice.title !== undefined || notice.url !== undefined || notice.autoPopup !== undefined
    ? `${key}:${JSON.stringify([notice.title, notice.url, notice.autoPopup])}` : key;
}

export const announcementUi = createStore({ open: false, automatic: false, noticeKey: '' });
export const closeAnnouncement = () => announcementUi.set({ open: false, automatic: false, noticeKey: '' });
let popupMemory = [];

function popupSeen() {
  const saved = loadPref('announcementPopupsSeen', popupMemory);
  return Array.isArray(saved) ? saved.filter((key) => typeof key === 'string').slice(-100) : [];
}

function rememberPopup(key) {
  popupMemory = [...popupSeen().filter((seen) => seen !== key), key].slice(-100);
  savePref('announcementPopupsSeen', popupMemory);
}

export function openAnnouncement() {
  const notice = store.get().popupAnnouncement;
  if (announcementLive(notice, net.serverNow())) rememberPopup(announcementDismissKey(notice));
  announcementUi.set({ open: true, automatic: false, noticeKey: '' });
}

// Include match startup, preparation, spectators and the result screen; reconnecting must not pop over a restored match.
const popupBlocked = (s) => !!s.room?.inMatch || !!(s.match?.public?.phase && s.match.public.phase !== PHASE.LOBBY);

/** Unseen notices wait until outside a match. Closing or reconnecting never reopens the same viewed version. */
export function syncAnnouncementPopup(notice, now, inMatch = popupBlocked(store.get())) {
  if (notice?.type !== 'popup' || !announcementLive(notice, now)) {
    if (announcementUi.get().automatic) closeAnnouncement();
    return;
  }
  if (inMatch) {
    if (announcementUi.get().automatic) closeAnnouncement();
    return; // Do not mark the notice viewed until it is actually shown (manual viewing still records it).
  }
  const key = announcementDismissKey(notice);
  if (announcementUi.get().automatic && announcementUi.get().noticeKey !== key) closeAnnouncement();
  if (notice.autoPopup === true && !popupSeen().includes(key)) {
    rememberPopup(key);
    announcementUi.set({ open: true, automatic: true, noticeKey: key });
  }
}

export function AnnouncementButton({ class: cls, variant = 'secondary', size = 'sm', onClick } = {}) {
  return html`<${Button} variant=${variant} size=${size} icon="info" class=${cls}
    aria-haspopup="dialog" title=${t('公告')} onClick=${() => { onClick?.(); openAnnouncement(); }}>${t('公告')}<//>`;
}

export function AnnouncementContent({ notice }) {
  if (!notice) return html`<p class="modal__text">${t('暂无公告')}</p>`;
  return html`<div class="announcement-content">
    <p class="modal__text">${notice.text}</p>
    ${notice.url ? html`<a class="announcement-content__link" href=${notice.url} target="_blank" rel="noopener noreferrer">
      <${Icon} name="link" />${t('查看详情')}<span class="announcement-content__url">${notice.url}</span>
    </a>` : null}
  </div>`;
}

export function AnnouncementHost() {
  const notice = useStore((s) => s.popupAnnouncement);
  const inMatch = useStore(popupBlocked);
  useStore((s) => s.clock.offset);
  const { open, automatic } = useStore((s) => s, Object.is, announcementUi);
  const now = net.serverNow();
  useTicker(notice && now < notice.endAt ? 250 : 0);
  const live = announcementLive(notice, now);
  const key = announcementDismissKey(notice);
  useEffect(() => { syncAnnouncementPopup(notice, net.serverNow(), inMatch); }, [key, live, inMatch]);
  return html`<${Modal} open=${open && (!automatic || !inMatch)} title=${live ? notice.title || t('公告') : t('公告')} micro="ANNOUNCEMENT"
    class="announcement-modal" width="min(7.4rem, 94vw)" onClose=${closeAnnouncement}
    actions=${html`<${Button} variant="primary" icon="close" data-autofocus onClick=${closeAnnouncement}>${t('关闭')}<//>`}>
    <${AnnouncementContent} notice=${live ? notice : null} />
  <//>`;
}

export function AnnouncementBanner() {
  const notice = useStore((s) => s.announcement);
  useStore((s) => s.clock.offset);
  const now = net.serverNow();
  useTicker(notice && now < notice.endAt ? 250 : 0);
  const key = announcementDismissKey(notice);
  const [dismissed, setDismissed] = useState(() => loadPref('announcementDismissed', ''));
  useEffect(() => {
    setDismissed(loadPref('announcementDismissed', '') === key ? key : '');
  }, [key]);
  const live = announcementLive(notice, now) && dismissed !== key;
  const viewport = useRef(null);
  const line = useRef(null);
  const [scroll, setScroll] = useState({ from: 0, to: 0, duration: 8 });
  useEffect(() => {
    if (!live) return undefined;
    const measure = () => {
      if (viewport.current && line.current) setScroll(announcementScroll(viewport.current.clientWidth, line.current.scrollWidth));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (viewport.current) observer?.observe(viewport.current);
    if (line.current) observer?.observe(line.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [live, notice]);
  if (!live) return null;
  const label = notice.level === 'urgent' ? t('紧急通知') : notice.level === 'warning' ? t('提醒') : t('通知');
  const dismiss = () => { savePref('announcementDismissed', key); setDismissed(key); };
  return html`<aside class=${`site-notice site-notice--${notice.level}`} role="status" aria-live="polite" aria-atomic="true">
    <span class="site-notice__label">${label}</span>
    <span class="site-notice__accessible">${notice.text}</span>
    <div ref=${viewport} class="site-notice__viewport" aria-hidden="true">
      <span ref=${line} key=${`${notice.id}:${notice.text}`} class="site-notice__text"
        style=${{ '--notice-from': `${scroll.from}px`, '--notice-to': `${scroll.to}px`, '--notice-duration': `${scroll.duration}s` }}>${notice.text}</span>
    </div>
    <button type="button" class="site-notice__close" aria-label=${t('关闭通知')} title=${t('关闭通知')} onClick=${dismiss}><${Icon} name="close" /><//>
  </aside>`;
}
