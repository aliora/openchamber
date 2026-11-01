import { describe, expect, it } from 'bun:test';

import { wrapSpacedImagePaths } from './spacedImagePaths';

describe('wrapSpacedImagePaths', () => {
  it('makes a spaced image path one destination', () => {
    expect(wrapSpacedImagePaths('![A](C:/Users/a/Dash Peak/x y.png)')).toBe('![A](<C:/Users/a/Dash Peak/x y.png>)');
  });

  it('leaves paths without spaces, titled images and bracketed destinations alone', () => {
    const text = '![A](C:/a/x.png) ![B](/a/b.png "title") ![C](<C:/a b/x.png>) [link](a b.png)';
    expect(wrapSpacedImagePaths(text)).toBe(text);
  });

  it('does not touch fenced code', () => {
    const text = '```\n![A](a b.png)\n```\n![B](a b.png)';
    expect(wrapSpacedImagePaths(text)).toBe('```\n![A](a b.png)\n```\n![B](<a b.png>)');
  });
});
