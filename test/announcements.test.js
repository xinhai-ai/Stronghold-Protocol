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
import { announcementScroll, announcementDismissKey } from '../public/js/ui/announcement.js';

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
  const active = row({ startAt: new Date(start).toISOString() });
  await writeFile(file, JSON.stringify(doc(active)));
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null,
    announcementsFile: file, announcementPollMs: 30 });
  t.after(() => srv.close());
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const title = await TestClient.connect(url), player = await TestClient.connect(url);
  t.after(() => title.close());
  t.after(() => player.close());
  const initial = await title.waitFor('site.announcement');
  assert.equal(initial.announcement.id, active.id);
  assert.equal(initial.announcement.endAt, start + 60000);
  await player.hello('公告测试');
  await player.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const inRoom = await player.waitFor('site.announcement');
  assert.equal(inRoom.announcement.id, active.id);
  await writeFile(file, JSON.stringify(doc(row({ ...active, text: '配置修改后推送到所有页面' }))));
  await Promise.all([title.waitFor('site.announcement', (m) => m.announcement?.text === '配置修改后推送到所有页面'),
    player.waitFor('site.announcement', (m) => m.announcement?.text === '配置修改后推送到所有页面')]);
  const reconnect = await TestClient.connect(url);
  t.after(() => reconnect.close());
  const restored = await reconnect.waitFor('site.announcement');
  assert.equal(restored.announcement.endAt, initial.announcement.endAt);
  await writeFile(file, JSON.stringify(doc()));
  await title.waitFor('site.announcement', (m) => m.announcement === null);
  await player.waitFor('site.announcement', (m) => m.announcement === null);
  const health = await (await fetch(`${srv.url}/healthz`)).json();
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
