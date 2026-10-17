const PLATFORM_PATTERNS = [
  [/Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/Linux|X11/, 'Linux'],
];

const platformOf = (userAgent) => PLATFORM_PATTERNS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Linux';

const architectureOf = (userAgent, nodeArch) => (/arm|aarch/i.test(userAgent) || nodeArch === 'arm64' ? 'arm' : 'x86');

export const buildUserAgentOverride = (version, nodeArch = process.arch) => {
  const userAgent = String(version?.userAgent ?? '').replace('HeadlessChrome', 'Chrome');
  const fullVersion = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(userAgent)?.[1];
  if (!userAgent || !fullVersion) return null;
  const major = fullVersion.split('.')[0];
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not.A/Brand', version: '99' },
  ];
  return {
    userAgent,
    userAgentMetadata: {
      brands,
      fullVersionList: [
        { brand: 'Chromium', version: fullVersion },
        { brand: 'Google Chrome', version: fullVersion },
        { brand: 'Not.A/Brand', version: '99.0.0.0' },
      ],
      platform: platformOf(userAgent),
      platformVersion: '15.0.0',
      architecture: architectureOf(userAgent, nodeArch),
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
};
