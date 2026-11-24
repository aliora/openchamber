import React from 'react';

import { useHostLabelFormatter } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { fetchHostModelProviders } from '@/lib/hosts/host-model-catalog';
import { createHostRequest, type HostRequest } from '@/lib/hosts/host-transport';
import { hostsMonitoring } from '@/lib/hosts/hosts-monitoring';
import { useHostSessionOpener } from '@/lib/hosts/hostSessionOpenerContext';
import { transferSession, type TransferModel } from '@/lib/hosts/session-transfer';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useSessionTransferStore } from './sessionTransferStore';

type HostOption = {
  /** Null for the focused host. */
  hostId: string | null;
  descriptor: HostDescriptor;
  label: string;
};

type ModelOption = { key: string; label: string; model: TransferModel };

const FOCUSED_HOST_VALUE = '__focused__';
const KEEP_MODEL_VALUE = '__keep__';

const optionValue = (hostId: string | null): string => hostId ?? FOCUSED_HOST_VALUE;

const useHostOptions = (): HostOption[] => {
  const formatLabel = useHostLabelFormatter();
  const { hosts, activeHost } = useMonitoredHosts();
  return React.useMemo(() => {
    const options: HostOption[] = hosts.map(({ descriptor }) => ({ hostId: descriptor.id, descriptor, label: formatLabel(descriptor) }));
    return activeHost ? [{ hostId: null, descriptor: activeHost, label: formatLabel(activeHost) }, ...options] : options;
  }, [activeHost, formatLabel, hosts]);
};

const useRequestFor = () => {
  const { t } = useI18n();
  return React.useCallback((option: HostOption): HostRequest => {
    if (option.hostId === null) return runtimeFetch;
    const message = t('sessionTransfer.toast.hostUnreachable', { host: option.label });
    const transport = hostsMonitoring.transportFor(option.hostId);
    return transport ? createHostRequest(transport, message, 120_000) : () => Promise.reject(new Error(message));
  }, [t]);
};

const useTargetModels = (request: HostRequest | null): ModelOption[] => {
  const [models, setModels] = React.useState<ModelOption[]>([]);
  React.useEffect(() => {
    setModels([]);
    if (!request) return undefined;
    let cancelled = false;
    fetchHostModelProviders(request)
      .then((providers) => {
        if (cancelled) return;
        setModels(providers.flatMap((provider) => (provider.models ?? []).flatMap((model) => {
          if (!model.id) return [];
          const modelName = model.name ?? model.id;
          return [{
            key: `${provider.id}/${model.id}`,
            label: `${provider.name ?? provider.id} · ${modelName}`,
            model: { providerID: provider.id, id: model.id },
          }];
        })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request]);
  return models;
};

/**
 * Moves a session to another saved host: the target, its model, whether the
 * working tree's uncommitted changes go along, what happens to the old
 * session, and the prompt the new one starts with.
 */
export const SessionTransferDialog: React.FC = () => {
  const { t } = useI18n();
  const target = useSessionTransferStore((state) => state.target);
  const close = useSessionTransferStore((state) => state.close);
  const hostOpener = useHostSessionOpener();
  const hostOptions = useHostOptions();
  const requestFor = useRequestFor();

  const sourceHostId = target?.sourceHostId ?? null;
  const destinations = React.useMemo(
    () => hostOptions.filter((option) => option.hostId !== sourceHostId),
    [hostOptions, sourceHostId],
  );
  const [destinationValue, setDestinationValue] = React.useState<string | null>(null);
  const [modelKey, setModelKey] = React.useState(KEEP_MODEL_VALUE);
  const [includeGitChanges, setIncludeGitChanges] = React.useState(true);
  const [archiveSource, setArchiveSource] = React.useState(true);
  const [sendPrompt, setSendPrompt] = React.useState(true);
  const [prompt, setPrompt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const sessionId = target?.sessionId ?? null;
  React.useEffect(() => {
    if (!sessionId) return;
    setDestinationValue(null);
    setModelKey(KEEP_MODEL_VALUE);
    setIncludeGitChanges(true);
    setArchiveSource(true);
    setSendPrompt(true);
    setPrompt(t('sessionTransfer.dialog.promptDefault'));
    setError(null);
  }, [sessionId, t]);

  const destination = destinations.find((option) => optionValue(option.hostId) === destinationValue) ?? destinations[0] ?? null;
  const source = hostOptions.find((option) => option.hostId === sourceHostId) ?? null;
  const destinationRequest = React.useMemo(() => (destination ? requestFor(destination) : null), [destination, requestFor]);
  const models = useTargetModels(destinationRequest);
  const selectedModel = models.find((option) => option.key === modelKey) ?? null;

  const submit = async () => {
    if (!target || !destination || !source || !destinationRequest) return;
    setBusy(true);
    setError(null);
    try {
      const result = await transferSession({
        sessionId: target.sessionId,
        source: { request: requestFor(source), label: source.label, runtimeKey: source.descriptor.runtimeKey },
        target: { request: destinationRequest, label: destination.label, runtimeKey: destination.descriptor.runtimeKey },
        includeGitChanges,
        archiveSource,
        prompt: sendPrompt ? prompt : undefined,
        model: selectedModel?.model,
      });
      close();
      toast.success(t('sessionTransfer.toast.moved', { host: destination.label }));
      if (result.gitTransferResult && !result.gitTransferResult.applied) {
        toast.warning(t('sessionTransfer.toast.gitNotApplied', { reason: result.gitTransferResult.warning ?? '' }));
      } else if (result.gitTransferResult?.warning) {
        toast.warning(t('sessionTransfer.toast.gitPartly', { reason: result.gitTransferResult.warning }));
      }
      if (result.promptError) toast.warning(t('sessionTransfer.toast.promptFailed', { reason: result.promptError }));
      if (result.warnings.includes('mark-failed')) toast.warning(t('sessionTransfer.toast.markFailed'));
      if (result.warnings.includes('archive-failed')) toast.warning(t('sessionTransfer.toast.archiveFailed'));
      void hostOpener.open({
        host: destination.descriptor,
        target: { kind: 'session', sessionId: result.targetSessionId, directory: result.directory },
        onProblem: () => toast.error(t('sessionTransfer.toast.openFailed', { host: destination.label })),
      });
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : String(transferError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="!max-w-[480px] w-[90vw]">
        <DialogHeader>
          <DialogTitle>{t('sessionTransfer.dialog.title')}</DialogTitle>
          <DialogDescription>{t('sessionTransfer.dialog.description', { title: target?.title ?? '' })}</DialogDescription>
        </DialogHeader>

        {destinations.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('sessionTransfer.dialog.noHosts')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="typography-ui-label text-foreground">{t('sessionTransfer.dialog.hostLabel')}</span>
              <Select value={destination ? optionValue(destination.hostId) : ''} onValueChange={(value: string) => { setDestinationValue(value); setModelKey(KEEP_MODEL_VALUE); }}>
                <SelectTrigger aria-label={t('sessionTransfer.dialog.hostLabel')}>
                  <SelectValue>{destination?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((option) => (
                    <SelectItem key={optionValue(option.hostId)} value={optionValue(option.hostId)}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="typography-ui-label text-foreground">{t('sessionTransfer.dialog.modelLabel')}</span>
              <Select value={modelKey} onValueChange={(value: string) => setModelKey(value)}>
                <SelectTrigger aria-label={t('sessionTransfer.dialog.modelLabel')}>
                  <SelectValue>{selectedModel?.label ?? t('sessionTransfer.dialog.modelKeep')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP_MODEL_VALUE}>{t('sessionTransfer.dialog.modelKeep')}</SelectItem>
                  {models.map((option) => (
                    <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 typography-ui-label text-foreground">
                <Checkbox checked={includeGitChanges} onChange={setIncludeGitChanges} ariaLabel={t('sessionTransfer.dialog.gitChanges')} />
                {t('sessionTransfer.dialog.gitChanges')}
              </label>
              <label className="flex items-center gap-2 typography-ui-label text-foreground">
                <Checkbox checked={archiveSource} onChange={setArchiveSource} ariaLabel={t('sessionTransfer.dialog.archiveSource')} />
                {t('sessionTransfer.dialog.archiveSource')}
              </label>
              <label className="flex items-center gap-2 typography-ui-label text-foreground">
                <Checkbox checked={sendPrompt} onChange={setSendPrompt} ariaLabel={t('sessionTransfer.dialog.sendPrompt')} />
                {t('sessionTransfer.dialog.sendPrompt')}
              </label>
            </div>

            {sendPrompt ? (
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                aria-label={t('sessionTransfer.dialog.promptLabel')}
                rows={3}
              />
            ) : null}

            {error ? <p role="alert" className="typography-meta text-[var(--status-error)] break-words">{error}</p> : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>{t('sessionTransfer.dialog.cancel')}</Button>
          <Button onClick={() => { void submit(); }} disabled={busy || !destination || !source}>
            {busy ? t('sessionTransfer.dialog.moving') : t('sessionTransfer.dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
