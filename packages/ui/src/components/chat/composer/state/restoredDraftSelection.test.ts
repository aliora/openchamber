import { describe, expect, test } from 'bun:test';

import { restoredDraftSelection } from './restoredDraftSelection';

describe('the selection a restored draft gets', () => {
  test('a saved draft on a desktop is selected so typing replaces it', () => {
    expect(restoredDraftSelection('saved', { isMobile: false, caretAtEnd: false })).toBe('all');
  });

  test('a saved draft on a phone keeps the caret at its end, without a selection to show handles for', () => {
    expect(restoredDraftSelection('saved', { isMobile: true, caretAtEnd: false })).toBe('end');
  });

  test('a draft opened for /btw keeps the caret at its end', () => {
    expect(restoredDraftSelection('saved', { isMobile: false, caretAtEnd: true })).toBe('end');
  });

  test('a fork replay is selected everywhere', () => {
    expect(restoredDraftSelection('fork', { isMobile: true, caretAtEnd: true })).toBe('all');
  });
});
