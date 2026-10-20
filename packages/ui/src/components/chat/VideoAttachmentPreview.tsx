import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { formatFileSize } from '@/lib/fileSize';
import { useI18n } from '@/lib/i18n';
import type { AttachedFile } from '@/stores/types/sessionTypes';

import { AttachmentUploadProgress } from './AttachmentUploadProgress';

const IOS_FIRST_FRAME_FRAGMENT = '#t=0.1';
const SECONDS_PER_MINUTE = 60;

const formatDuration = (seconds: number): string => {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
  return `${minutes}:${String(whole % SECONDS_PER_MINUTE).padStart(2, '0')}`;
};

const useObjectUrl = (file: Blob): string | null => {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return url;
};

type VideoAttachmentPreviewProps = {
  file: AttachedFile;
  onRemove: () => void;
};

export const VideoAttachmentPreview = React.memo(function VideoAttachmentPreview({ file, onRemove }: VideoAttachmentPreviewProps) {
  const { t } = useI18n();
  const url = useObjectUrl(file.file);
  const [duration, setDuration] = React.useState<number | null>(null);
  const size = formatFileSize(file.size);

  return (
    <div
      data-attachment-kind="video"
      className="relative h-16 w-28 flex-shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
      title={file.filename}
    >
      {url ? (
        <video
          src={`${url}${IOS_FIRST_FRAME_FRAGMENT}`}
          preload="metadata"
          muted
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          className="pointer-events-none h-full w-full object-cover"
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            setDuration(Number.isFinite(seconds) ? seconds : null);
          }}
        />
      ) : null}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <Icon name="play" className="h-5 w-5 text-white drop-shadow" />
      </span>
      <span className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-between gap-1 px-1.5 text-[10px] font-medium text-white drop-shadow">
        <span>{duration !== null ? formatDuration(duration) : <Icon name="film" className="h-3 w-3" />}</span>
        <span>{size}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="group absolute top-0 inset-e-0 z-10 flex items-start justify-end p-1 focus-visible:outline-none"
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: file.filename })}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-background/80 text-foreground transition-colors group-hover:bg-background group-focus-visible:ring-1 group-focus-visible:ring-ring">
          <Icon name="close" className="h-3.5 w-3.5" />
        </span>
      </button>
      <AttachmentUploadProgress attachmentId={file.id} />
    </div>
  );
});
