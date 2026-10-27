import type { IconName } from '@/components/icon/icons';
import { CUSTOM_PROVIDER_ICONS } from '@/lib/customProviderIcons';

export const ENGINE_DEFAULT_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
} as const;

export type AppearanceEngineId = keyof typeof ENGINE_DEFAULT_NAMES;

export const ENGINE_DOT_COLORS = [
  { id: 'orange', value: '#da7756' },
  { id: 'blue', value: '#4f8ef7' },
  { id: 'green', value: '#4caf7d' },
  { id: 'violet', value: '#9b7bea' },
  { id: 'rose', value: '#e5627f' },
  { id: 'gray', value: '#8b8f98' },
] as const;

type DotColorId = (typeof ENGINE_DOT_COLORS)[number]['id'];

export type EngineLogo = 'default' | 'letter' | `dot:${DotColorId}` | `icon:${string}`;

export type EngineAppearanceEntry = { name?: string; logo?: EngineLogo };

export type EngineAppearance = Partial<Record<AppearanceEngineId, EngineAppearanceEntry>>;

export const ENGINE_NAME_MAX_LENGTH = 24;

export const isAppearanceEngineId = (value: unknown): value is AppearanceEngineId => (
  typeof value === 'string' && Object.hasOwn(ENGINE_DEFAULT_NAMES, value)
);

const HOST_ICONS = [
  { id: 'computer', icon: 'computer' },
  { id: 'laptop', icon: 'macbook' },
  { id: 'server', icon: 'server' },
  { id: 'phone', icon: 'smartphone' },
  { id: 'board', icon: 'hard-drive-2' },
  { id: 'cloud', icon: 'cloud' },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName }>;

const LOGO_ICONS: Readonly<Record<string, IconName>> = Object.fromEntries(
  [...CUSTOM_PROVIDER_ICONS, ...HOST_ICONS].map((entry) => [entry.id, entry.icon]),
);

const logoChoices = (icons: ReadonlyArray<{ id: string }>): readonly EngineLogo[] => [
  'default',
  'letter',
  ...ENGINE_DOT_COLORS.map((color) => `dot:${color.id}` as const),
  ...icons.map((entry) => `icon:${entry.id}` as const),
];

export const ENGINE_LOGO_CHOICES = logoChoices(CUSTOM_PROVIDER_ICONS);
export const HOST_LOGO_CHOICES = logoChoices(HOST_ICONS);

const LOGO_CHOICES = new Set<string>([...ENGINE_LOGO_CHOICES, ...HOST_LOGO_CHOICES]);

export const isEngineLogo = (value: unknown): value is EngineLogo => typeof value === 'string' && LOGO_CHOICES.has(value);

export const parseEngineAppearance = (value: unknown): EngineAppearance | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: EngineAppearance = {};
  for (const [engine, raw] of Object.entries(value)) {
    if (!isAppearanceEngineId(engine) || !raw || typeof raw !== 'object') continue;
    const { name, logo } = raw as Record<string, unknown>;
    const trimmed = typeof name === 'string' ? name.trim().slice(0, ENGINE_NAME_MAX_LENGTH) : '';
    const entry: EngineAppearanceEntry = {
      ...(trimmed ? { name: trimmed } : {}),
      ...(isEngineLogo(logo) && logo !== 'default' ? { logo } : {}),
    };
    if (entry.name || entry.logo) result[engine] = entry;
  }
  return result;
};

export type EngineView = {
  engine: AppearanceEngineId;
  name: string;
  logo: EngineLogo;
};

export const resolveEngineView = (engine: AppearanceEngineId, appearance: EngineAppearance): EngineView => ({
  engine,
  name: appearance[engine]?.name || ENGINE_DEFAULT_NAMES[engine],
  logo: appearance[engine]?.logo ?? 'default',
});

export const engineLogoIconName = (logo: EngineLogo): IconName | null => {
  return logo.startsWith('icon:') ? LOGO_ICONS[logo.slice(5)] ?? null : null;
};

export const engineLogoDotColor = (logo: EngineLogo): string | null => (
  logo.startsWith('dot:') ? ENGINE_DOT_COLORS.find((color) => color.id === logo.slice(4))?.value ?? null : null
);

export const HOST_KEY_MAX_LENGTH = 128;

export const parseHostLogos = (value: unknown): Record<string, EngineLogo> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, EngineLogo> = {};
  for (const [key, logo] of Object.entries(value)) {
    if (key && key.length <= HOST_KEY_MAX_LENGTH && isEngineLogo(logo) && logo !== 'default') result[key] = logo;
  }
  return result;
};
