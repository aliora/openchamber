import React from 'react';
import { SettingsFieldRow, SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { EngineSignInDialog } from '@/components/setup-wizard/EngineSignInDialog';
import type { EngineId } from '@/components/setup-wizard/engineSetupModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { changeEngineAccount, fetchEngineAccountAuth, fetchEngineAccounts, notifyEngineAccountsChanged, subscribeEngineAccountChanges, type EngineAccount, type EngineAccounts } from '@/lib/engineAccounts';
import { useI18n } from '@/lib/i18n';
import { useScopedHostRuntime } from './engineHost';
import { useQuotaStore } from '@/stores/useQuotaStore';

const AccountRow = ({ engine, account, disabled, enterpriseMode, onAction, onLogin }: {
  engine: EngineId; account: EngineAccount; disabled: boolean; enterpriseMode: boolean;
  onAction: (action: 'default' | 'remove' | 'logout', account: EngineAccount) => void;
  onLogin: (id: string) => void;
}) => {
  const { t } = useI18n();
  const host = useScopedHostRuntime();
  const [auth, setAuth] = React.useState<Awaited<ReturnType<typeof fetchEngineAccountAuth>> | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    setAuth(null);
    setFailed(false);
    void host.run(() => fetchEngineAccountAuth(engine, account.id)).then((next) => {
      if (!disposed) setAuth(next);
    }, () => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [host, engine, account.id]);
  return (
    <SettingsFieldRow label={<span className="flex min-w-0 items-center gap-2"><span dir="auto" className="truncate">{account.label}</span>{account.isDefault ? <SettingsCardPill tone="neutral">{t('engines.accounts.default')}</SettingsCardPill> : null}</span>} alignEnd={false}
      description={failed ? t('engines.signIn.unknown') : auth ? auth.loggedIn ? auth.email ?? t('engines.signIn.signedIn') : t('engines.signIn.signedOut') : t('common.loading')}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || enterpriseMode} onClick={() => onLogin(account.id)}>{t('engines.signIn.login')}</Button>
        {auth?.loggedIn ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction('logout', account)}>{t('engines.signIn.logout')}</Button> : null}
        {!account.isDefault ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction('default', account)}>{t('engines.accounts.useDefault')}</Button> : null}
        {account.id !== 'default' ? <Button size="sm" variant="ghost" disabled={disabled || account.isDefault} onClick={() => onAction('remove', account)}>{t('settings.providers.accounts.remove')}</Button> : null}
      </div>
    </SettingsFieldRow>
  );
};

export const EngineAccountsSection = ({ engine, enterpriseMode }: { engine: EngineId; enterpriseMode: boolean }) => {
  const { t } = useI18n();
  const host = useScopedHostRuntime();
  const [inventory, setInventory] = React.useState<{ host: typeof host; engine: EngineId; accounts: EngineAccounts } | null>(null);
  const accounts = inventory?.host === host && inventory.engine === engine ? inventory.accounts : null;
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [revision, setRevision] = React.useState(0);
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<EngineAccount | null>(null);
  const scope = React.useRef({ host, engine });
  scope.current = { host, engine };
  React.useEffect(() => {
    setError(null);
    setBusy(false);
    setLabel('');
    setSigningIn(null);
    setRemoving(null);
  }, [host, engine]);
  React.useEffect(() => host.run(() => subscribeEngineAccountChanges(() => setRevision((value) => value + 1))), [host]);
  React.useEffect(() => {
    let disposed = false;
    void host.run(() => fetchEngineAccounts(engine)).then((next) => {
      if (!disposed && !host.disposed) { setInventory({ host, engine, accounts: next }); setError(null); }
    }, (reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : t('engines.accounts.failed')); });
    return () => { disposed = true; };
  }, [host, engine, revision, t]);
  const mutate = async (action: 'add' | 'default' | 'remove' | 'logout', account?: EngineAccount) => {
    const isCurrent = () => !host.disposed && scope.current.host === host && scope.current.engine === engine;
    setBusy(true);
    setError(null);
    try {
      await host.run(() => changeEngineAccount(engine, action, account?.id, label.trim()));
      if (!isCurrent()) return;
      host.run(notifyEngineAccountsChanged);
      if (engine === 'claude' || engine === 'codex') {
        await host.run(() => useQuotaStore.getState().fetchProviderQuota(engine, true));
      }
      if (!isCurrent()) return;
      if (action === 'add') setLabel('');
      setRemoving(null);
    } catch (reason: unknown) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : t('engines.accounts.failed'));
    } finally { if (isCurrent()) setBusy(false); }
  };
  return (
    <SettingsSection title={t('engines.accounts.title')} info={t('engines.accounts.info')} settingsItem="providers.engine-accounts" contentClassName="space-y-3"
      headerAction={<Button size="sm" variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t('engines.page.refresh')}</Button>}>
      <p role="status" className="min-h-5 truncate typography-meta text-[var(--status-error)]" title={error ?? undefined}>{error ?? (!accounts ? t('common.loading') : '')}</p>
      {accounts?.supported === false ? <p className="typography-meta text-muted-foreground">{t('engines.accounts.unsupported')}</p> : accounts ? <>
        <div>{accounts.data.map((account) => <AccountRow key={`${account.id}:${revision}`} engine={engine} account={account} disabled={busy} enterpriseMode={enterpriseMode}
          onLogin={setSigningIn} onAction={(action, selected) => action === 'remove' ? setRemoving(selected) : void mutate(action, selected)} />)}</div>
        <SettingsStackedField label={t('settings.providers.accounts.add')}>
          <form className="flex min-w-0 gap-2" onSubmit={(event) => { event.preventDefault(); void mutate('add'); }}>
            <Input value={label} maxLength={80} disabled={busy || enterpriseMode} aria-label={t('settings.providers.accounts.nameAria')} placeholder={t('settings.providers.accounts.nameAria')} onChange={(event) => setLabel(event.target.value)} />
            <Button type="submit" size="sm" disabled={busy || enterpriseMode || !label.trim()}>{t('settings.providers.accounts.add')}</Button>
          </form>
        </SettingsStackedField>
      </> : null}
      {enterpriseMode ? <p className="typography-meta text-muted-foreground">{t('engineSetup.enterpriseLogin')}</p> : null}
      {signingIn ? <EngineSignInDialog engine={engine} accountId={signingIn} onClose={() => { setSigningIn(null); setRevision((value) => value + 1); }} /> : null}
      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('settings.providers.accounts.remove')}</DialogTitle><DialogDescription>{t('filesView.dialog.delete.description', { name: removing?.label ?? '' })}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setRemoving(null)}>{t('dialog.common.actions.cancel')}</Button><Button variant="destructive" disabled={busy} onClick={() => { if (removing) void mutate('remove', removing); }}>{t('settings.providers.accounts.remove')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
