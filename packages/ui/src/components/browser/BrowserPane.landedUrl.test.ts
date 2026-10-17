/**
 * A click on a link or a submitted form moves the tab to another page. The
 * click script can only report the page it ran on, so its answer said the tab
 * was still there after a followed link (seen live: `browser.click #next`
 * answered `http://127.0.0.1:18765/` while the tab showed `second.html`).
 *
 * The agent action runner lives inside `WebviewBrowser`, which needs an
 * Electron webview and the event stream to mount, so this follows the
 * source-level guard used by the neighbouring BrowserPane regression test
 * (`layout/__tests__/issue-3175-browserCaptureRevealsPanel.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'BrowserPane.tsx'), 'utf-8');

const NAVIGATING_ACTION = "if (action === 'browser.click' || (action === 'browser.type' && parameters.submit === true)) {";

describe('the answer to a click or a submit', () => {
  test('names the page the tab shows once the navigation it started has landed', () => {
    const start = source.indexOf(NAVIGATING_ACTION);
    expect(start).toBeGreaterThan(-1);
    const branch = source.slice(start, source.indexOf('return result;', start));

    const waited = branch.indexOf('await waitForIdle();');
    const read = branch.indexOf('toDisplayUrl(webview.getURL())');
    expect(waited).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(waited);
    expect(branch).toContain('{ ...record, url: landedUrl }');
  });
});
