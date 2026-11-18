import React from 'react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  formatResumeTime,
  nextTimeOfDay,
  setSessionAutoResume,
  toTimeInputValue,
} from '@/lib/sessionAutoResume';
import { useSessionAutoResume } from './useSessionAutoResume';

const FALLBACK_DELAY_MS = 30 * 60_000;

/**
 * The "resume when the limit lifts" switch, with the time and the prompt it
 * sends. The server keeps the timer (`auto-resume.js`), so the resume happens
 * with this window closed too.
 */
export const SessionAutoResumeControl: React.FC<{ sessionId: string; directory?: string; className?: string }> = ({ sessionId, directory, className }) => {
  const { t, locale } = useI18n();
  const state = useSessionAutoResume(sessionId, directory);
  const recordedAt = state?.resumeAt && state.resumeAt > Date.now() ? state.resumeAt : null;
  const [time, setTime] = React.useState(() => toTimeInputValue(recordedAt ?? Date.now() + FALLBACK_DELAY_MS));
  const [prompt, setPrompt] = React.useState(state?.prompt ?? '');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (recordedAt) setTime(toTimeInputValue(recordedAt));
  }, [recordedAt]);
  const storedPrompt = state?.prompt ?? '';
  React.useEffect(() => {
    setPrompt(storedPrompt);
  }, [storedPrompt]);

  const enabled = Boolean(state?.enabled);

  const save = async (nextEnabled: boolean) => {
    setSaving(true);
    try {
      await setSessionAutoResume(runtimeFetch, sessionId, {
        enabled: nextEnabled,
        resumeAt: nextEnabled ? nextTimeOfDay(time, Date.now()) : undefined,
        prompt: prompt.trim() ? prompt.trim() : null,
      });
    } catch (error) {
      toast.error(t('chat.autoResume.saveFailed', { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };

  const shownTime = recordedAt ? formatResumeTime(recordedAt, locale) : time;

  return (
    <div className={className}>
      <label className="flex items-center gap-2 typography-meta text-foreground">
        <Switch
          checked={enabled}
          loading={saving}
          disabled={saving}
          onCheckedChange={(checked) => { void save(checked); }}
          aria-label={t('chat.autoResume.toggle', { time: shownTime })}
        />
        <span>{t('chat.autoResume.toggle', { time: shownTime })}</span>
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          onBlur={() => { if (enabled) void save(true); }}
          aria-label={t('chat.autoResume.timeLabel')}
          className="h-7 w-28"
        />
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={() => { if (enabled && prompt !== storedPrompt) void save(true); }}
          placeholder={t('chat.autoResume.promptPlaceholder')}
          aria-label={t('chat.autoResume.promptLabel')}
          className="h-7 min-w-0 flex-1"
        />
      </div>
      {state?.status === 'scheduled' && recordedAt ? (
        <p className="mt-1 typography-micro text-muted-foreground">{t('chat.autoResume.scheduled', { time: formatResumeTime(recordedAt, locale) })}</p>
      ) : null}
      {state?.status === 'running' ? (
        <p className="mt-1 typography-micro text-muted-foreground">{t('chat.autoResume.running')}</p>
      ) : null}
      {state?.status === 'failed' && state.lastError ? (
        <p className="mt-1 typography-micro text-[var(--status-error)] break-words">{t('chat.autoResume.failed', { reason: state.lastError })}</p>
      ) : null}
    </div>
  );
};
