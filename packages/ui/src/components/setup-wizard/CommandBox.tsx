import React from 'react';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

type CommandBoxProps = {
  command: string;
  onRun?: () => void;
  runLabel?: string;
};

export const CommandBox: React.FC<CommandBoxProps> = ({ command, onRun, runLabel }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void copyTextToClipboard(command).then((result) => {
      if (result.ok) setCopied(true);
    });
  };
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
      <code className="typography-meta min-w-0 flex-1 basis-48 truncate rounded bg-muted px-2 py-1" title={command}>{command}</code>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? t('engineSetup.action.copied') : t('engineSetup.action.copy')}
        </Button>
        {onRun ? <Button size="sm" variant="outline" onClick={onRun}>{runLabel}</Button> : null}
      </div>
    </div>
  );
};
