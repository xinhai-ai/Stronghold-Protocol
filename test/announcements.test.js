import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAnnouncements, activeAnnouncement, announcementLive, announcementFromMessage } from '../shared/announcements.js';
import { Announcements, ANNOUNCEMENT_MAX_BYTES } from '../server/announcements.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { announcementScroll, announcementDismissKey, announcementUi, syncAnnouncementPopup,
  openAnnouncement, closeAnnouncement, AnnouncementButton, AnnouncementContent } from '../public/js/ui/announcement.js';
import { store } from '../public/js/store.js';
import { OnlineCount, PingPill } from '../public/js/ui/components.js';

const BASE = Date.parse('2026-10-05T12:00:00+08:00');
const row = (overrides = {}) => ({ id: 'maintenance', text: '维护通知', startAt: new Date(BASE).toISOString(), durationSeconds: 60, level: 'info', enabled: true, ...overrides });
const doc = (...rows) => ({ announcements: rows });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-announcements-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'announcements.json') };
}

test('config validation: timezone, plain text, limits, unique ids and explicit booleans', () => {
  assert.deepEqual(parseAnnouncements(doc()), []);
  const [n] = parseAnnouncements(doc(row({ text: '  临时通知\n请留意  ' })));
  assert.equal(n.text, '临时通知 请留意');
  assert.equal(n.startAt, BASE);
  assert.equal(n.endAt, BASE + 60000);
  assert.equal(parseAnnouncements(doc(row({ title: '  计划维护  ' })))[0].title, '计划维护');
  for (const title of ['', '   ', 42, 'x'.repeat(81)]) assert.throws(() => parseAnnouncements(doc(row({ title }))));
  assert.equal(parseAnnouncements(doc(row({ startAt: '2026-10-05T12:00:00.1234567+08:00' })))[0].startAt, BASE + 123);
  assert.throws(() => parseAnnouncements(doc(row({ startAt: '2026-10-05T12:00:00' }))));
  assert.throws(() => parseAnnouncements(doc(row({ startAt: '2026-02-30T12:00:00+08:00' }))));
  assert.throws(() => parseAnnouncements(doc(row({ level: ['info'] }))));
  for (const changes of [{ text: '' }, { text: 'x'.repeat(501) }, { durationSeconds: 0 }, { durationSeconds: 86401 },
    { durationSeconds: 1.5 }, { level: 'constructor' }, { enabled: 'false' }, { id: 'bad id' }]) {
    assert.throws(() => parseAnnouncements(doc(row(changes))));
  }
  assert.throws(() => parseAnnouncements(doc(row(), row())));
  assert.throws(() => parseAnnouncements(doc(...Array.from({ length: 101 }, (_, i) => row({ id: `n-${i}` })))));
  assert.equal(parseAnnouncements(doc(row({ text: '<script>alert(1)</script>' })))[0].text, '<script>alert(1)</script>');
});

test('absolute start/expiry, severity and same-level ordering never extend a hidden notice', () => {
  const rows = parseAnnouncements(doc(row(), row({ id: 'urgent', level: 'urgent', durationSeconds: 10 }),
    row({ id: 'disabled', level: 'urgent', enabled: false })));
  assert.equal(activeAnnouncement(rows, BASE - 1), null);
  assert.equal(activeAnnouncement(rows, BASE).id, 'urgent');
  assert.equal(activeAnnouncement(rows, BASE + 10000).id, 'maintenance');
  assert.equal(activeAnnouncement(rows, BASE + 60000), null);
  const same = parseAnnouncements(doc(row({ id: 'later', startAt: new Date(BASE + 1000).toISOString() }), row({ id: 'earlier' })));
  assert.equal(activeAnnouncement(same, BASE + 1001).id, 'earlier');
  assert.equal(announcementLive(rows[0], BASE + 60000), false);
});

test('title, link and popup options round trip through config and public messages; legacy schedules stay compatible', () => {
  const options = { type: 'popup', title: '  更新公告  ', url: 'https://example.com/notice?a=1&b=2', autoPopup: true };
  const notice = activeAnnouncement(parseAnnouncements(doc(row(options))), BASE, 'popup');
  const client = announcementFromMessage({ popupAnnouncement: notice }, 'popup');
  assert.deepEqual(client, notice);
  assert.equal(client.title, '更新公告');
  assert.equal(client.url, options.url);
  assert.equal(client.autoPopup, true);
  const manual = activeAnnouncement(parseAnnouncements(doc(row({ type: 'popup', autoPopup: false }))), BASE, 'popup');
  assert.equal(announcementFromMessage({ popupAnnouncement: manual }, 'popup').autoPopup, false);
  const legacy = activeAnnouncement(parseAnnouncements(doc(row())), BASE);
  assert.deepEqual(announcementFromMessage({ announcement: legacy }), legacy);
  assert.equal(legacy.autoPopup, undefined);
  assert.equal(parseAnnouncements(doc(row({ type: 'popup', url: 'http://localhost:3000/notice' })))[0].url, 'http://localhost:3000/notice');
  for (const changes of [{ type: 'both' }, { autoPopup: true }, { url: 'https://example.com' }]) {
    assert.throws(() => parseAnnouncements(doc(row(changes))));
  }

  for (const changes of [{ title: 'bad\nheader' }, { autoPopup: 'false' }, { autoPopup: 1 },
    ...['javascript:alert(1)', 'data:text/html,hello', '//example.com', '/notice', 'https://user:secret@example.com/',
      'https://example.com/\nnotice', 'https://example.com/a b', '', 42, 'https://example.com/' + 'a'.repeat(2048)].map((url) => ({ url }))]) {
    assert.throws(() => parseAnnouncements(doc(row({ type: 'popup', ...changes }))));
    assert.equal(announcementFromMessage({ popupAnnouncement: { ...notice, ...changes } }, 'popup'), null);
  }
  for (const changes of [{ title: '新标题' }, { url: 'https://example.com/new' }, { autoPopup: true }]) {
    assert.notEqual(announcementDismissKey({ ...legacy, ...changes }), announcementDismissKey(legacy));
  }
});

test('scheduler publishes only changed active state, survives invalid edits and supports atomic replacement / withdrawal', async (t) => {
  const { file, dir } = await fixture(t);
  let now = BASE - 1000;
  const frames = [], warnings = [];
  await writeFile(file, JSON.stringify(doc(row())));
  const service = new Announcements({ file, now: () => now, broadcast: (msg) => frames.push(msg),
    log: { warn: (s) => warnings.push(s), error() {} } });
  t.after(() => service.stop());
  await service.start();
  assert.equal(service.current, null);
  now = BASE;
  service.refresh();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].serverNow, BASE);
  await service.reload();
  service.refresh();
  assert.equal(frames.length, 1);
  await writeFile(file, '{');
  assert.equal(await service.reload(), false);
  assert.equal(service.current.id, 'maintenance');
  await service.reload();
  assert.equal(warnings.length, 1, 'identical bad edits are not logged repeatedly');
  const replacement = join(dir, 'replacement.json');
  await writeFile(replacement, JSON.stringify(doc(row({ text: '更新内容' }))));
  await rename(replacement, file);
  await service.reload();
  assert.equal(service.current.text, '更新内容');
  now = BASE + 60000;
  service.refresh();
  assert.equal(frames.at(-1).announcement, null);
  now = BASE + 500;
  service.refresh();
  await writeFile(file, JSON.stringify(doc()));
  await service.reload();
  assert.equal(service.current, null);
  await service.stop();
  assert.equal(service.pollTimer, null);
  assert.equal(service.boundaryTimer, null);
});

test('scrolling and popup schedules select, expire and withdraw independently', async (t) => {
  const { file } = await fixture(t);
  let now = BASE;
  const scroll = row({ level: 'urgent' });
  const popup = row({ id: 'popup', type: 'popup', title: '详情公告', autoPopup: true, durationSeconds: 10 });
  const laterPopup = row({ id: 'popup-later', type: 'popup', startAt: new Date(BASE + 1000).toISOString() });
  await writeFile(file, JSON.stringify(doc(scroll, popup, laterPopup)));
  const frames = [];
  const service = new Announcements({ file, now: () => now, broadcast: (msg) => frames.push(msg) });
  t.after(() => service.stop());
  await service.start();
  assert.equal(service.current.id, scroll.id);
  assert.equal(service.popupCurrent.id, popup.id, 'urgent scroll does not suppress an info popup');
  assert.equal(service.stats().popupActiveId, popup.id);
  assert.equal(announcementFromMessage({ announcement: service.popupCurrent }), null);
  assert.equal(announcementFromMessage({ popupAnnouncement: service.current }, 'popup'), null);
  now = BASE + 10000;
  service.refresh();
  assert.equal(service.popupCurrent.id, laterPopup.id);
  assert.equal(service.current.id, scroll.id);
  await writeFile(file, JSON.stringify(doc(laterPopup)));
  await service.reload();
  assert.equal(frames.at(-1).announcement, null);
  assert.equal(frames.at(-1).popupAnnouncement.id, laterPopup.id, 'scroll withdrawal leaves popup active');
  now = BASE + 61000;
  service.refresh();
  assert.equal(service.popupCurrent, null);
});

test('late start recovers only the unexpired period; missing / oversized config does not crash the game', async (t) => {
  const { file } = await fixture(t);
  const service = new Announcements({ file, now: () => BASE + 45000 });
  t.after(() => service.stop());
  await service.start();
  assert.equal(service.current, null);
  await writeFile(file, ' '.repeat(ANNOUNCEMENT_MAX_BYTES + 1));
  assert.equal(await service.reload(), false);
  await writeFile(file, JSON.stringify(doc(row())));
  await service.reload();
  assert.equal(service.current.endAt, BASE + 60000, 'restart never resets the 60-second window');
  const expired = new Announcements({ file, now: () => BASE + 60000 });
  t.after(() => expired.stop());
  await expired.start();
  assert.equal(expired.current, null);
});

test('timer activates and expires a scheduled notice without changing its configuration', async (t) => {
  const { file } = await fixture(t);
  const begins = Date.now() + 250;
  await writeFile(file, JSON.stringify(doc(row({ startAt: new Date(begins).toISOString(), durationSeconds: 1 }))));
  const frames = [];
  const service = new Announcements({ file, broadcast: (msg) => frames.push(msg) });
  t.after(() => service.stop());
  await service.start();
  await delay(400);
  assert.equal(frames[0].announcement.id, 'maintenance');
  await delay(1000);
  assert.equal(frames.at(-1).announcement, null);
});

test('global WS delivery works before hello, in rooms and across reconnects; file polling reloads live', async (t) => {
  const { file } = await fixture(t);
  const start = Date.now() - 1000;
  const active = row({ type: 'popup', startAt: new Date(start).toISOString(), title: '维护安排', url: 'https://example.com/notice', autoPopup: true });
  const scrolling = row({ id: 'scrolling', startAt: active.startAt, level: 'urgent', text: '独立滚动通知' });
  await writeFile(file, JSON.stringify(doc(active, scrolling)));
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null,
    announcementsFile: file, announcementPollMs: 30 });
  t.after(() => srv.close());
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const title = await TestClient.connect(url), player = await TestClient.connect(url);
  t.after(() => title.close());
  t.after(() => player.close());
  const initial = await title.waitFor('site.announcement');
  assert.equal(initial.popupAnnouncement.id, active.id);
  assert.equal(initial.popupAnnouncement.endAt, start + 60000);
  assert.equal(initial.popupAnnouncement.title, active.title);
  assert.equal(initial.popupAnnouncement.url, active.url);
  assert.equal(initial.popupAnnouncement.autoPopup, true);
  assert.deepEqual(announcementFromMessage(initial, 'popup'), initial.popupAnnouncement);
  assert.equal(initial.announcement.id, scrolling.id);
  assert.deepEqual(announcementFromMessage(initial), initial.announcement);
  await player.hello('公告测试');
  await player.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const inRoom = await player.waitFor('site.announcement');
  assert.equal(inRoom.popupAnnouncement.id, active.id);
  await writeFile(file, JSON.stringify(doc(row({ ...active, text: '配置修改后推送到所有页面' }), scrolling)));
  await Promise.all([title.waitFor('site.announcement', (m) => m.popupAnnouncement?.text === '配置修改后推送到所有页面'),
    player.waitFor('site.announcement', (m) => m.popupAnnouncement?.text === '配置修改后推送到所有页面')]);
  await writeFile(file, JSON.stringify(doc({ ...active, url: 'https://example.com/new', autoPopup: false }, scrolling)));
  const changed = await title.waitFor('site.announcement', (m) => m.popupAnnouncement?.autoPopup === false);
  assert.equal(changed.popupAnnouncement.url, 'https://example.com/new');
  assert.deepEqual(changed.announcement, initial.announcement, 'popup edits leave scrolling notice unchanged');
  const reconnect = await TestClient.connect(url);
  t.after(() => reconnect.close());
  const restored = await reconnect.waitFor('site.announcement');
  assert.equal(restored.popupAnnouncement.endAt, initial.popupAnnouncement.endAt);
  await writeFile(file, JSON.stringify(doc(scrolling)));
  const withdrawn = await title.waitFor('site.announcement', (m) => m.popupAnnouncement === null);
  assert.deepEqual(withdrawn.announcement, initial.announcement, 'withdrawing popup keeps scrolling notice live');
  await writeFile(file, JSON.stringify(doc()));
  await title.waitFor('site.announcement', (m) => m.announcement === null);
  await player.waitFor('site.announcement', (m) => m.announcement === null);
  const health = await (await fetch(`${srv.url}/metrics`)).json();
  assert.equal(health.announcements.entries, 0);
  assert.equal(health.announcements.configError, null);
  assert.equal((await fetch(`${srv.url}/config/announcements.json`)).status, 404, 'operator configuration is not served');
  await srv.close();
  assert.equal(srv.announcements.stopped, true);
});

test('client message validation and constant-speed scrolling use plain text and absolute expiry', () => {
  const notice = activeAnnouncement(parseAnnouncements(doc(row())), BASE);
  assert.deepEqual(announcementFromMessage({ announcement: notice }), notice);
  assert.equal(announcementFromMessage({ announcement: null }), null);
  assert.equal(announcementFromMessage({ announcement: { ...notice, endAt: NaN } }), null);
  assert.equal(announcementFromMessage({ announcement: { ...notice, level: 'constructor' } }), null);
  const short = announcementScroll(350, 350), long = announcementScroll(350, 1400);
  assert.equal(short.duration, 10);
  assert.equal(long.duration, 25);
  assert.deepEqual([long.from, long.to], [350, -1400]);
  assert.equal(announcementDismissKey(notice), `maintenance:${BASE}:${BASE + 60000}:维护通知`);
});

test('popup lifecycle respects opt-in, persistent viewing, content edits, manual reopening and absolute expiry', (t) => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => {
    globalThis.localStorage = previousStorage;
    closeAnnouncement();
    store.set({ announcement: null, popupAnnouncement: null });
  });
  const notice = activeAnnouncement(parseAnnouncements(doc(row({ type: 'popup', autoPopup: true }))), BASE, 'popup');
  for (const n of [{ ...notice, autoPopup: false }, { ...notice, autoPopup: undefined }, { ...notice, type: 'scroll' }, null]) {
    syncAnnouncementPopup(n, BASE);
    assert.equal(announcementUi.get().open, false);
  }
  syncAnnouncementPopup(notice, BASE - 1);
  assert.equal(announcementUi.get().open, false);
  syncAnnouncementPopup(notice, BASE);
  assert.deepEqual(announcementUi.get(), { open: true, automatic: true, noticeKey: announcementDismissKey(notice) });
  closeAnnouncement();
  syncAnnouncementPopup(notice, BASE + 1);
  assert.equal(announcementUi.get().open, false, 'reconnect does not reopen the seen version');
  const updated = { ...notice, url: 'https://example.com/updated' };
  syncAnnouncementPopup(updated, BASE + 2);
  assert.equal(announcementUi.get().open, true, 'link-only edits are new versions');
  syncAnnouncementPopup(null, BASE + 3);
  assert.equal(announcementUi.get().open, false, 'withdrawal closes automatic popup');
  syncAnnouncementPopup(notice, BASE + 4);
  assert.equal(announcementUi.get().open, false, 'restoring an earlier notice does not reopen it');
  const urgent = { ...notice, id: 'urgent', title: '紧急通知' };
  syncAnnouncementPopup(urgent, BASE + 5);
  assert.equal(announcementUi.get().open, true);
  syncAnnouncementPopup(notice, BASE + 6);
  assert.equal(announcementUi.get().open, false, 'switching to a seen notice closes the preceding automatic popup');
  syncAnnouncementPopup({ ...urgent, text: '更新紧急通知' }, BASE + 7);
  assert.equal(announcementUi.get().open, true);
  syncAnnouncementPopup(urgent, urgent.endAt);
  assert.equal(announcementUi.get().open, false, 'expiry closes automatic popup');

  const current = { ...notice, autoPopup: false, startAt: Date.now() - 1000, endAt: Date.now() + 60_000 };
  store.set({ popupAnnouncement: current });
  const trigger = AnnouncementButton();
  trigger.props.onClick();
  assert.deepEqual(announcementUi.get(), { open: true, automatic: false, noticeKey: '' });
  closeAnnouncement();
  openAnnouncement();
  assert.equal(announcementUi.get().open, true, 'manual reopening works for seen notices');
  closeAnnouncement();
  store.set({ popupAnnouncement: null });
  store.set({ announcement: { ...current, type: 'scroll' } });
  openAnnouncement();
  assert.equal(announcementUi.get().open, true, 'empty state can still be opened');
  const seen = JSON.parse(values.get('sp.pref.announcementPopupsSeen'));
  assert.ok(!seen.includes(announcementDismissKey({ ...current, type: 'scroll' })), 'manual button does not view scrolling announcements');
});

test('announcement content remains plain text, links open safely, and online count shares latency styling', () => {
  function* walk(v) {
    if (Array.isArray(v)) { for (const child of v) yield* walk(child); return; }
    if (!v || typeof v !== 'object') return;
    yield v;
    yield* walk(v.props?.children);
  }
  const notice = { text: '<script>alert(1)</script>', url: 'https://example.com/notice' };
  const nodes = [...walk(AnnouncementContent({ notice }))];
  assert.equal(nodes.find((v) => v.type === 'p').props.children, notice.text);
  assert.ok(nodes.every((v) => !v.props?.dangerouslySetInnerHTML));
  const link = nodes.find((v) => v.type === 'a');
  assert.equal(link.props.href, notice.url);
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noopener noreferrer');
  assert.ok(![...walk(AnnouncementContent({ notice: { text: '无链接' } }))].some((v) => v.type === 'a'));
  assert.equal(AnnouncementContent({ notice: null }).props.children, '暂无公告');
  for (const component of [OnlineCount({ online: 13 }), OnlineCount({ online: null }), PingPill({ ms: 58 })]) {
    assert.ok(component.props.class.split(' ').includes('ping'));
    assert.ok([...walk(component)].some((v) => v.props?.class?.split(' ').includes('ping__unit')));
  }
});
