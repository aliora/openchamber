/**
 * Plain-language names and one-line descriptions of what the composer's
 * Effort and Permission menus list: reasoning effort levels (a model's
 * variants), shared with the model picker rows and the mobile effort sheet,
 * and engine permission modes.
 */
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { EnginePermissionModeOption } from '@/stores/useEngineControlsStore';
import { isMessageKey } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const EFFORT_LEVEL_KEYS: ReadonlyMap<string, { label: I18nKey; description: I18nKey }> = new Map([
  ['minimal', { label: 'chat.composer.effort.level.minimal.label', description: 'chat.composer.effort.level.minimal.description' }],
  ['low', { label: 'chat.composer.effort.level.low.label', description: 'chat.composer.effort.level.low.description' }],
  ['medium', { label: 'chat.composer.effort.level.medium.label', description: 'chat.composer.effort.level.medium.description' }],
  ['high', { label: 'chat.composer.effort.level.high.label', description: 'chat.composer.effort.level.high.description' }],
  ['xhigh', { label: 'chat.composer.effort.level.xhigh.label', description: 'chat.composer.effort.level.xhigh.description' }],
  ['max', { label: 'chat.composer.effort.level.max.label', description: 'chat.composer.effort.level.max.description' }],
  ['ultra', { label: 'chat.composer.effort.level.ultra.label', description: 'chat.composer.effort.level.ultra.description' }],
]);

interface ControlOptionText {
  label: string;
  description: string | null;
}

/**
 * A level this build knows by its translated name and description. Any other
 * level, such as a provider's own name, is its id with a capital first letter
 * and no description.
 */
export const describeEffortLevel = (t: Translate, level: string): ControlOptionText => {
  const keys = EFFORT_LEVEL_KEYS.get(level);
  if (keys) return { label: t(keys.label), description: t(keys.description) };
  const trimmed = level.trim();
  return { label: trimmed.charAt(0).toUpperCase() + trimmed.slice(1), description: null };
};

/**
 * A permission mode by the label and description keys the server named for
 * it. A key this build does not have, such as one of a newer server's
 * modes, shows the mode's id and no description.
 */
export const describePermissionMode = (t: Translate, mode: EnginePermissionModeOption): ControlOptionText => ({
  label: isMessageKey(mode.labelKey) ? t(mode.labelKey) : mode.id,
  description: isMessageKey(mode.descriptionKey) ? t(mode.descriptionKey) : null,
});
