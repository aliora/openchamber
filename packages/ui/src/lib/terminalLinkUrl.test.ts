import { describe, expect, test } from 'bun:test';
import { findLastExternalTerminalUrl } from './terminalLinkUrl';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz';

describe('terminal link url', () => {
  test('finds a hyperlinked login url printed by a CLI', () => {
    const raw = `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${ESC}]8;;${LOGIN_URL}${BEL}${ESC}[94m${LOGIN_URL}${ESC}[39m${ESC}]8;;${BEL}\r\nPaste code here if prompted > `;
    expect(findLastExternalTerminalUrl(raw)).toBe(LOGIN_URL);
  });

  test('keeps the most recent url and drops trailing punctuation', () => {
    expect(findLastExternalTerminalUrl('see https://a.example/one, then (https://b.example/two).\r\n')).toBe('https://b.example/two');
  });

  test('ignores local dev server urls and plain text', () => {
    expect(findLastExternalTerminalUrl('Local: http://localhost:5173/\r\n')).toBeNull();
    expect(findLastExternalTerminalUrl('no links here')).toBeNull();
  });
});
