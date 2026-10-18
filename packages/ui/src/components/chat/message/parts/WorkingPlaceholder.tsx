import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { prefersReducedMotion } from '@/lib/layoutAnimation';
import { getWorkingPersona, getWorkingVerbKeys } from './workingPersona';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  agentName?: string;
  modelName?: string | null;
  modelId?: string | null;
  providerId?: string | null;
}

const STATUS_DISPLAY_TIME_MS = 1200;
const VERB_ROTATION_MS = 3000;

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

const toRetryTargetTimestamp = (next: number): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next;
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000;
  }
  return Date.now() + next;
};

const formatRetryCountdown = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remainderMinutes = Math.floor((seconds % 3600) / 60);
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(seconds / 86400);
  const remainderHours = Math.floor((seconds % 86400) / 3600);
  if (remainderHours > 0) {
    return `${days}d ${remainderHours}h`;
  }

  return `${days}d`;

};

export function WorkingPlaceholder({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  modelName,
  modelId,
  providerId,
}: WorkingPlaceholderProps) {
  const { t } = useI18n();
  const { src: providerLogoSrc, onError: handleProviderLogoError, hasLogo: hasProviderLogo } = useProviderLogo(providerId ?? null);
  const { currentTheme } = useThemeSystem();
  const isDarkTheme = currentTheme?.metadata.variant === 'dark';
  const [displayedText, setDisplayedText] = React.useState<string | null>(null);
  const [displayedPermission, setDisplayedPermission] = React.useState<boolean>(false);
  const displayedTextRef = React.useRef(displayedText);
  const displayedPermissionRef = React.useRef(displayedPermission);
  displayedTextRef.current = displayedText;
  displayedPermissionRef.current = displayedPermission;

  const statusShownAtRef = React.useRef<number>(0);
  const queuedStatusRef = React.useRef<{ text: string; permission: boolean } | null>(null);
  const processQueueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const persona = getWorkingPersona(providerId, modelId);
  const verbKeys = getWorkingVerbKeys(persona);
  const rotatesVerb = verbKeys.length > 0 && !displayedPermission && (displayedText === 'thinking' || Boolean(isGenericStatus));
  const [verbIndex, setVerbIndex] = React.useState(0);

  React.useEffect(() => {
    if (!rotatesVerb || prefersReducedMotion()) return;
    const id = setInterval(() => setVerbIndex((index) => index + 1), VERB_ROTATION_MS);
    return () => clearInterval(id);
  }, [rotatesVerb]);

  // Countdown state for retry mode
  const [retryCountdown, setRetryCountdown] = React.useState<number | null>(null);

  React.useEffect(() => {
    const rawNext = retryInfo?.next;
    if (!rawNext || rawNext <= 0) {
      setRetryCountdown(null);
      return;
    }

    const retryTargetAt = toRetryTargetTimestamp(rawNext);

    const update = () => {
      const remaining = Math.max(0, retryTargetAt - Date.now());
      setRetryCountdown(Math.ceil(remaining / 1000));
    };

    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [retryInfo?.next, retryInfo?.attempt]);

  const clearTimers = React.useCallback(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current);
      processQueueTimerRef.current = null;
    }
  }, []);

  const showStatus = React.useCallback((text: string, permission: boolean) => {
    clearTimers();
    queuedStatusRef.current = null;
    setDisplayedText(text);
    setDisplayedPermission(permission);
    statusShownAtRef.current = Date.now();
  }, [clearTimers]);

  const scheduleQueueProcess = React.useCallback(() => {
    if (processQueueTimerRef.current) return;
    const elapsed = Date.now() - statusShownAtRef.current;
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed);
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null;

      const queued = queuedStatusRef.current;
      if (queued) {
        showStatus(queued.text, queued.permission);
      }
    }, remaining);
  }, [showStatus]);

  React.useEffect(() => {
    if (!isWorking) {
      clearTimers();
      queuedStatusRef.current = null;
      setDisplayedText(null);
      setDisplayedPermission(false);
      return;
    }

    // Retry state has its own display — skip the normal queue
    if (retryInfo) {
      clearTimers();
      queuedStatusRef.current = null;
      return;
    }

    const incomingText = isWaitingForPermission ? 'waiting for permission' : statusText;
    const incomingPermission = Boolean(isWaitingForPermission);
    const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission;

    if (!incomingText) {
      return;
    }

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    if (incomingText === displayedTextRef.current && incomingPermission === displayedPermissionRef.current) {
      return;
    }

    // Ignore generic churn.
    if (incomingGeneric) {
      return;
    }

    const elapsed = Date.now() - statusShownAtRef.current;
    if (elapsed >= STATUS_DISPLAY_TIME_MS) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    queuedStatusRef.current = { text: incomingText, permission: incomingPermission };
    scheduleQueueProcess();
  }, [
    isWorking,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
    retryInfo,
    clearTimers,
    showStatus,
    scheduleQueueProcess,
  ]);

  React.useEffect(() => () => clearTimers(), [clearTimers]);

  if (!isWorking) {
    return null;
  }

  const providerLogo = hasProviderLogo && providerLogoSrc ? (
    // Flex sibling of the label, never an inline rider on the text line: a
    // tall inline-block drags the line box with it and the label drifts off
    // the chip's vertical center. As flex children both center independently.
    <span className="oc-working-mark flex h-4 w-4 shrink-0 me-1.5" aria-hidden="true">
      <img
        src={providerLogoSrc}
        alt=""
        // 16px box like the scroll pill's arrow icon. The padding normalizes
        // the mark to the arrow glyph's geometry (~10.4px wide, ~2.8px inset),
        // so equal boxes and equal paddings also mean equal visible edges.
        className="animate-status-logo h-4 w-4 p-[1.3px]"
        style={{
          filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
        }}
        onError={handleProviderLogoError}
      />
    </span>
  ) : null;

  // Retry state: show countdown and attempt info
  if (retryInfo) {
    const attemptLabel = retryInfo.attempt && retryInfo.attempt > 1 ? ` (attempt ${retryInfo.attempt})` : '';
    const countdownLabel = retryCountdown !== null && retryCountdown > 0
      ? ` in ${formatRetryCountdown(retryCountdown)}`
      : '';
    const retryText = `Retrying${countdownLabel}${attemptLabel}`;

    return (
      <div
        className="flex h-full items-center text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label={retryText}
      >
        {providerLogo}
        <span className="typography-ui-header">{retryText}</span>
      </div>
    );
  }

  if (!displayedText) {
    return null;
  }

  const trimmedModelName = modelName?.trim() ?? '';
  const formatLabel = (status: string) => trimmedModelName.length > 0
    ? t('chat.statusRow.modelStatus', { model: trimmedModelName, status })
    : status.charAt(0).toUpperCase() + status.slice(1);
  const label = formatLabel(displayedText);
  const verbKey = verbKeys[verbIndex % verbKeys.length];
  const visibleLabel = rotatesVerb && verbKey ? formatLabel(t(verbKey)) : label;

  return (
    <div
      // Full muted-foreground, matching the scroll-to-bottom pill's status
      // text: the row and the pill hand off to each other in the same spot
      // and must read as one element changing chrome.
      className={
        'oc-working flex h-full items-center text-muted-foreground'
      }
      data-persona={persona}
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      aria-label={label}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      {providerLogo}
      <span className="oc-working-shimmer text-[13px] leading-4" aria-hidden={rotatesVerb || undefined}>{visibleLabel}</span>
    </div>
  );
}
