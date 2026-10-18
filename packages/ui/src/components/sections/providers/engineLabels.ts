import type { InstallSource } from '@/components/setup-wizard/engineSetupModel';
import type { I18nKey } from '@/lib/i18n';

export const SOURCE_LABEL: Record<InstallSource, I18nKey> = {
  npm: 'engines.source.npm',
  native: 'engines.source.native',
  brew: 'engines.source.brew',
  unknown: 'engines.source.unknown',
};
