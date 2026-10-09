import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CHAT_MAX_LENGTH, CHAT_HISTORY_LIMIT, chatLength, truncateChat, validChatText, appendChat } from '../shared/chat.js';
import { validateC2S, S2C } from '../shared/protocol.js';
import { activeBubbles } from '../public/js/ui/gameLogic/watch.js';
import { GLYPHS, GIcon } from '../public/js/ui/gameComponents.js';

test('chat: 20 Unicode code points, with identical client/protocol validation', () => {
  assert.equal(CHAT_MAX_LENGTH, 20);
  for (const text of ['你好', '中'.repeat(20), 'a'.repeat(20), '😀'.repeat(20), '<b>你好</b>', ' 等等 ']) {
    assert.equal(validChatText(text), true, text);
    assert.equal(validateC2S({ t: 'g.chat', text }), null, text);
  }
  for (const text of ['', '   ', '中'.repeat(21), '😀'.repeat(21), 'a\nb', 'a\tb', 'a\u0000b', 'a\u2028b', '\ud800', 123, null, undefined, {}]) {
    assert.equal(validChatText(text), false, String(text));
    assert.ok(validateC2S({ t: 'g.chat', text }), String(text));
  }
  assert.equal(chatLength('中😀a'), 3);
  assert.equal(truncateChat('😀'.repeat(21)), '😀'.repeat(20));
  assert.ok(S2C.includes('m.chat'));
});

test('history keeps the last 100 messages without mutating snapshots; text bubbles expire', () => {
  let history = [];
  for (let seq = 1; seq <= 105; seq++) {
    const prev = history;
    history = appendChat(history, { seq, playerId: 'p_0', name: '玩家', text: '你好', at: seq });
    assert.notEqual(history, prev);
    assert.equal(prev.some((e) => e.seq === seq), false);
  }
  assert.equal(history.length, CHAT_HISTORY_LIMIT);
  assert.equal(history[0].seq, 6);
  const bubbles = activeBubbles(history, 106, 3);
  assert.deepEqual(bubbles.get('p_0'), { id: undefined, seq: 105, at: 105, text: '你好' });
  assert.equal(activeBubbles(history, 109, 3).size, 0);
});

test('left buttons switch between emotes and history above one persistent composer', () => {
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/emotes.css', import.meta.url), 'utf8');
  assert.match(ui, /class="ewheel__compose"/);
  assert.match(ui, /\[chatView, setChatView\] = useState\('emotes'\)/);
  assert.match(ui, /class="echat__tabs"/);
  assert.match(ui, /setChatView\('emotes'\)/);
  assert.match(ui, /setChatView\('history'\)/);
  assert.match(ui, /hidden=\$\{!!onChat && chatView !== 'emotes'\}/);
  assert.match(ui, /onChat && chatView === 'history'[\s\S]*?<section class="echat__history-pane"[\s\S]*?<\$\{ChatHistory\}/);
  assert.doesNotMatch(ui, /echat__sidebar|echat__heading/);
  assert.match(css, /\.ewheel__dialog\.has-chat\s*\{[^}]*grid-template-columns:\s*40px minmax\(0, 1fr\)/);
  assert.match(css, /\.echat\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.echat__history\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.echat__form\s*\{[^}]*display:\s*flex/);
});

test('view buttons use SVG glyphs, with labels/tooltips and the history count retained', () => {
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  const tabs = ui.slice(ui.indexOf('<nav class="echat__tabs"'), ui.indexOf('</nav>'));
  for (const label of ['表情', '聊天历史']) {
    assert.ok(tabs.includes(`aria-label=\${t('${label}')}`));
    assert.ok(tabs.includes(`title=\${t('${label}')}`));
  }
  assert.match(tabs, /<\$\{GIcon\} name="emote"/);
  assert.match(tabs, /<\$\{GIcon\} name="history"/);
  assert.match(tabs, /class="echat__tab-count">\$\{history\.length\}/);
  assert.doesNotMatch(tabs, />\$\{t\('(表情|历史)'\)\}</);
  for (const name of ['emote', 'history']) {
    const icon = GIcon({ name });
    assert.equal(icon.type, 'svg');
    assert.equal(icon.props.viewBox, '0 0 24 24');
    assert.equal(icon.props['aria-hidden'], 'true');
    const path = [icon.props.children].flat(3).find((child) => child?.type === 'path');
    assert.equal(path.props.d, GLYPHS[name]);
  }
});

test('chat uses smaller actual component boxes and keeps all six emotes visible on mobile', () => {
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/emotes.css', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /mobileEmotes|shows-emotes|echat__emotes-toggle/);
  assert.match(ui, /theme\.emotes\.map\(/);
  assert.match(css, /\.ewheel__dialog\.has-chat\s*\{[^}]*--ewheel-cell-size:\s*44px[^}]*width:\s*260px/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__page\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[^}]*grid-template-rows:\s*repeat\(2, var\(--ewheel-cell-size\)\)/);
  assert.match(css, /\.echat__input\s*\{[^}]*height:\s*24px[^}]*min-height:\s*24px[^}]*line-height:\s*20px/);
  assert.match(css, /\.echat__send\s*\{[^}]*height:\s*24px[^}]*min-height:\s*24px[^}]*line-height:\s*20px/);
  const compact = css.slice(css.indexOf('@media (max-width: 600px)'), css.indexOf('@keyframes emo-panel-in'));
  assert.match(compact, /\(max-width: 1100px\) and \(any-pointer: coarse\)/);
  assert.match(compact, /\.ewheel__dialog\.has-chat\s*\{[^}]*--ewheel-cell-size:\s*32px[^}]*width:\s*220px/);
  assert.match(css, /\.echat__history-pane\s*\{[^}]*height:\s*calc\(var\(--ewheel-cell-size\) \* 2 \+ 44px\)/);
  assert.match(compact, /\.echat__input\s*\{[^}]*font-size:\s*16px/);
  assert.doesNotMatch(compact, /display:\s*none|flex-wrap:\s*wrap|scale:/);
});

test('both emote rows and the pager use natural flow, with bounded images and isolated touch targets', () => {
  const css = readFileSync(new URL('../public/css/emotes.css', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  assert.match(ui, /class="ewheel__pager"/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__panel\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto 24px[^}]*height:\s*auto/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__viewport\s*\{[^}]*height:\s*auto/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__item\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__item \.eart\s*\{[^}]*max-height:\s*100%[^}]*object-fit:\s*contain/);
  assert.match(css, /\.ewheel__dialog\.has-chat \.ewheel__panel \.ewheel__nav\.is-prev::before,[\s\S]*?\.ewheel__nav\.is-next::before\s*\{\s*inset:\s*0/);
});

test('composer has fixed 24px border-box controls instead of an inherited oversized line height', () => {
  const css = readFileSync(new URL('../public/css/emotes.css', import.meta.url), 'utf8');
  assert.match(css, /\.echat\s*\{[^}]*padding:\s*2px 4px/);
  for (const cls of ['echat__input', 'echat__send']) {
    const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))[1];
    assert.match(rule, /\bheight:\s*24px/);
    assert.match(rule, /box-sizing:\s*border-box/);
    assert.match(rule, /padding:\s*1px (3|4)px/);
    assert.match(rule, /font:\s*inherit;[^}]*line-height:\s*20px/);
    const height = Number(rule.match(/\bheight:\s*(\d+)px/)[1]);
    const line = Number(rule.match(/line-height:\s*(\d+)px/)[1]);
    const padding = Number(rule.match(/padding:\s*(\d+)px/)[1]);
    const border = Number(rule.match(/border:\s*(\d+)px/)[1]);
    assert.equal(line + padding * 2 + border * 2, height, 'text line and vertical spacing fit the fixed box');
  }
});

// Execute the actual component handler with hook state/refs replaced by small test doubles.
function composerHarness() {
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  const handler = ui.slice(ui.indexOf('  const sendChat = async (event) => {'), ui.indexOf('  // swipe / drag'));
  let finish;
  const calls = [];
  const ctx = {
    draft: '你好', disabled: false, cooling: false, sending: false,
    composing: { current: false }, pendingChat: { current: false },
    lastSentAt: -Infinity, cooldownMs: 1000, validChatText,
    cooldownLeft: (sentAt, now, ms) => Math.max(0, sentAt + ms - now),
    chatInput: { current: { focus: () => calls.push('focus') } },
    setSending: (value) => { ctx.sending = value; },
    setCooling: (value) => { ctx.cooling = value; },
    setDraft: (update) => { ctx.draft = typeof update === 'function' ? update(ctx.draft) : update; },
    onChat: (text) => { calls.push(text); return new Promise((resolve) => { finish = resolve; }); },
  };
  const send = runInNewContext(`${handler}\nsendChat`, ctx);
  return { ctx, calls, send: () => send({ preventDefault() {} }), finish: (ok) => finish(ok) };
}

test('sending/cooldown keeps input focus, rejects duplicate sends and preserves a newly typed draft', async () => {
  const h = composerHarness();
  const pending = h.send();
  assert.deepEqual(h.calls, ['focus', '你好']);
  assert.equal(h.ctx.pendingChat.current, true);
  h.ctx.draft = '下一条';
  await h.send();
  assert.deepEqual(h.calls, ['focus', '你好', 'focus']);
  h.finish(true);
  await pending;
  assert.equal(h.ctx.draft, '下一条');
  assert.equal(h.ctx.pendingChat.current, false);
  assert.equal(h.ctx.sending, false);
  await h.send();
  assert.equal(h.calls.filter((value) => value === '你好').length, 1);
  assert.equal(h.calls.at(-1), 'focus');
});

test('successful send clears only unchanged drafts; failed send retains draft without refocusing on reply', async () => {
  for (const ok of [true, false]) {
    const h = composerHarness();
    const pending = h.send();
    h.finish(ok);
    await pending;
    assert.equal(h.ctx.draft, ok ? '' : '你好');
    assert.deepEqual(h.calls, ['focus', '你好']);
  }
});

test('composer is not disabled by sending/cooldown and pointer presses preserve keyboard focus', () => {
  const ui = readFileSync(new URL('../public/js/ui/emotes.js', import.meta.url), 'utf8');
  const input = ui.slice(ui.indexOf('<input type="text" class="echat__input"'), ui.indexOf('<span class="echat__count">'));
  assert.match(input, /ref=\$\{chatInput\}/);
  assert.match(input, /disabled=\$\{disabled\}/);
  assert.doesNotMatch(input, /disabled=\$\{[^}]*sending|disabled=\$\{[^}]*cooling/);
  assert.match(ui, /class="echat__send" disabled=\$\{disabled\}[\s\S]*?aria-disabled=[\s\S]*?onPointerDown=[\s\S]*?e\.preventDefault\(\)/);
});
