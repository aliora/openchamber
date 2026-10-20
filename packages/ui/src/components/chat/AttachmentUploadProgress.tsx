import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useAttachmentUpload } from '@/sync/attachment-uploads';

type AttachmentUploadProgressProps = {
  attachmentId: string;
};

export const AttachmentUploadProgress = React.memo(function AttachmentUploadProgress({ attachmentId }: AttachmentUploadProgressProps) {
  const { t } = useI18n();
  const upload = useAttachmentUpload(attachmentId);

  if (upload?.status === 'failed') {
    return (
      <span
        className="absolute bottom-1 inset-s-1 flex h-4 w-4 items-center justify-center rounded-sm bg-background/80 text-[var(--status-error)]"
        title={t('chat.fileAttachment.upload.failed', { reason: upload.message })}
        aria-label={t('chat.fileAttachment.upload.failed', { reason: upload.message })}
      >
        <Icon name="error-warning" className="h-3 w-3" />
      </span>
    );
  }
  if (upload?.status !== 'uploading') return null;

  const percent = upload.total > 0 ? Math.min(100, Math.round((upload.sent / upload.total) * 100)) : 0;
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={t('chat.fileAttachment.upload.progress', { percent })}
      title={t('chat.fileAttachment.upload.progress', { percent })}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-background/60"
    >
      <span className="block h-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
    </span>
  );
});
