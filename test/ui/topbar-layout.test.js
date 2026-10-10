import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('lobby and room place announcements immediately after online count', async () => {
  const [lobby, room] = await Promise.all([
    readFile(new URL('../../public/js/screens/lobby.js', import.meta.url), 'utf8'),
    readFile(new URL('../../public/js/screens/room.js', import.meta.url), 'utf8'),
  ]);
  for (const source of [lobby, room]) {
    const announcement = source.indexOf('<${AnnouncementButton} variant="ghost" size="sm" class="topbar-announcement" />');
    const online = source.indexOf('<${OnlineCount} online=${presence.online} />');
    assert.ok(announcement > online, 'announcement must follow online count');
    assert.equal((source.match(/<\$\{AnnouncementButton\}/g) || []).length, 1, 'topbar has one announcement action');
  }
});

test('narrow topbars wrap the title and collapse secondary labels without clipping the connection cluster', async () => {
  const css = await readFile(new URL('../../public/css/components.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-areas: "left right" "center center"/);
  assert.match(css, /\.topbar-announcement \.btn__label[\s\S]*clip: rect/);
  assert.match(css, /\.topbar__right \.me-chip__text \{ display: none; \}/);
});
