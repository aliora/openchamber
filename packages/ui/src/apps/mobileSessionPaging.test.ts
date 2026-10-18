import { describe, expect, test } from 'bun:test';

import { pageRows, WORK_SECTION_PAGE_SIZE } from './mobileSessionPaging';

const rows = (count: number) => Array.from({ length: count }, (_, index) => index);

describe('pageRows', () => {
  test('the In work page is three rows', () => {
    expect(WORK_SECTION_PAGE_SIZE).toBe(3);
  });

  test('a short list shows every row without controls', () => {
    expect(pageRows(rows(3), undefined, 3)).toEqual({ visible: [0, 1, 2], hiddenCount: 0, canShowFewer: false });
  });

  test('a long list shows the first page and counts the rest', () => {
    expect(pageRows(rows(12), undefined, 3)).toEqual({ visible: [0, 1, 2], hiddenCount: 9, canShowFewer: false });
  });

  test('revealing everything offers to show fewer', () => {
    expect(pageRows(rows(12), Number.MAX_SAFE_INTEGER, 3)).toEqual({ visible: rows(12), hiddenCount: 0, canShowFewer: true });
  });

  test('a list that shrank under its revealed count stays plain', () => {
    expect(pageRows(rows(2), Number.MAX_SAFE_INTEGER, 3)).toEqual({ visible: [0, 1], hiddenCount: 0, canShowFewer: false });
  });
});
