import type { I18nKey } from '@/lib/i18n';

export type WorkingPersona = 'claude' | 'openai' | 'gemini' | 'default';

type BrandedPersona = Exclude<WorkingPersona, 'default'>;

const PERSONA_PATTERNS: ReadonlyArray<readonly [BrandedPersona, RegExp]> = [
  ['claude', /anthropic|claude/],
  ['openai', /openai|codex|chatgpt|gpt/],
  ['gemini', /google|gemini|antigravity|gemma/],
];

const PERSONA_VERB_KEYS: Record<WorkingPersona, readonly I18nKey[]> = {
  claude: [
    'chat.statusRow.verb.thinking',
    'chat.statusRow.verb.pondering',
    'chat.statusRow.verb.mulling',
    'chat.statusRow.verb.crafting',
  ],
  openai: [
    'chat.statusRow.verb.reasoning',
    'chat.statusRow.verb.thinking',
    'chat.statusRow.verb.iterating',
    'chat.statusRow.verb.computing',
  ],
  gemini: [
    'chat.statusRow.verb.thinking',
    'chat.statusRow.verb.exploring',
    'chat.statusRow.verb.imagining',
    'chat.statusRow.verb.reasoning',
  ],
  default: [],
};

const matchPersona = (value: string | null | undefined): BrandedPersona | null => {
  const normalized = value?.toLowerCase() ?? '';
  if (!normalized) return null;
  return PERSONA_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
};

export const getWorkingPersona = (providerId: string | null | undefined, modelId?: string | null): WorkingPersona =>
  matchPersona(modelId) ?? matchPersona(providerId) ?? 'default';

export const getWorkingVerbKeys = (persona: WorkingPersona): readonly I18nKey[] => PERSONA_VERB_KEYS[persona];
