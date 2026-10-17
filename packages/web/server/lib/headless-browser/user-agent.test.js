import { describe, expect, it } from 'vitest';
import { buildUserAgentOverride } from './user-agent.js';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.7632.10 Safari/537.36';

describe('buildUserAgentOverride', () => {
  it('drops the headless marker and fills the client hints a real Chrome sends', () => {
    const override = buildUserAgentOverride({ userAgent: MAC }, 'arm64');
    expect(override.userAgent).not.toContain('Headless');
    expect(override.userAgentMetadata).toMatchObject({
      platform: 'macOS',
      architecture: 'arm',
      mobile: false,
      brands: [{ brand: 'Chromium', version: '155' }, { brand: 'Google Chrome', version: '155' }, { brand: 'Not.A/Brand', version: '99' }],
    });
    expect(override.userAgentMetadata.fullVersionList[0].version).toBe('155.0.7632.10');
  });

  it('recognises Windows and Linux', () => {
    expect(buildUserAgentOverride({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.1 Safari/537.36' }, 'x64').userAgentMetadata).toMatchObject({ platform: 'Windows', architecture: 'x86' });
    expect(buildUserAgentOverride({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64) HeadlessChrome/130.0.0.1' }, 'arm64').userAgentMetadata).toMatchObject({ platform: 'Linux', architecture: 'arm' });
  });

  it('gives up on a version string it cannot read', () => {
    expect(buildUserAgentOverride({ userAgent: 'curl/8' })).toBeNull();
    expect(buildUserAgentOverride({})).toBeNull();
  });
});
