import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const COPIED_FEEDBACK_MS = 1_500;

/**
 * The terminal command that makes an engine usable (install it, sign in),
 * shown under its greyed-out models with a button that copies it.
 */
export const EngineFixCommand: React.FC<{ command: string; className?: string }> = ({ command, className }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const result = await copyTextToClipboard(command);
    if (result.ok) setCopied(true);
    else toast.error(t('chat.modelControls.engine.copyFailed'));
  };

  const label = copied ? t('chat.modelControls.engine.commandCopied') : t('chat.modelControls.engine.copyCommand');

  return (
    <div className={cn('oc-tile-inset flex items-center gap-1.5 rounded-md py-0.5 ps-2 pe-0.5', className)}>
      <Icon name="terminal" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      {/* A command reads left to right in every language; it still lines up with the interface's start. */}
      <code dir="ltr" className="oc-ui-start-align min-w-0 flex-1 truncate font-mono typography-micro text-foreground select-text" title={command}>
        {command}
      </code>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          void copy();
        }}
        aria-label={label}
        title={label}
      >
        <Icon name={copied ? 'check' : 'clipboard'} className="size-3.5" />
      </Button>
    </div>
  );
};
