// Count Unicode code points, not UTF-16 units: a Chinese character or a simple emoji counts as one.
export const CHAT_MAX_LENGTH = 20;
export const CHAT_HISTORY_LIMIT = 100;
export const chatLength = (text) => Array.from(text).length;
export const truncateChat = (text) => Array.from(text).slice(0, CHAT_MAX_LENGTH).join('');

/** Single-line, nonblank text; reject control characters and malformed Unicode at both trust boundaries. */
export function validChatText(text) {
  return typeof text === 'string' && text.length <= CHAT_MAX_LENGTH * 2
    && text.trim().length > 0 && chatLength(text) <= CHAT_MAX_LENGTH
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u.test(text);
}

/** Bounded page-local history. Never mutate an earlier store snapshot. */
export function appendChat(history, entry) {
  return [...history.slice(-(CHAT_HISTORY_LIMIT - 1)), entry];
}
