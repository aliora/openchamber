/**
 * The composer's account menu for Claude and Codex: switches the host-wide
 * active engine account Settings → Engines manages, so the next message of
 * any chat, this one included, runs on it. A running reply keeps its account.
 * A signed-out account is not activated; its sign-in dialog opens instead.
 * The trigger and the menu name the engine, so a chat shows whose accounts these are.
 */

import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { EngineSignInDialog } from '@/components/setup-wizard/EngineSignInDialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EngineLogoMark } from '@/components/ui/EngineLogoMark';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { fetchEngineAccountAuth } from '@/lib/engineAccounts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useEngineAccountMenu } from '../state/useEngineAccountMenu';

interface EngineAccountMenuProps {
    providerId: string;
    heightClass: string;
    iconSizeClass: string;
    textClass: string;
    isMobile: boolean;
}

export const EngineAccountMenu = ({ providerId, heightClass, iconSizeClass, textClass, isMobile }: EngineAccountMenuProps) => {
    const { t } = useI18n();
    const host = useScopedHostRuntime();
    const menu = useEngineAccountMenu(providerId);
    const [open, setOpen] = React.useState(false);
    const [switching, setSwitching] = React.useState(false);
    const [signedIn, setSignedIn] = React.useState<ReadonlyMap<string, boolean>>(new Map());
    const [signingIn, setSigningIn] = React.useState<string | null>(null);
    const engine = menu?.engine;
    const accountIds = menu?.accounts.map((account) => account.id).join('\n') ?? '';

    React.useEffect(() => {
        if (!open || !engine) return;
        let disposed = false;
        for (const accountId of accountIds.split('\n')) {
            void host.run(() => fetchEngineAccountAuth(engine, accountId)).then((auth) => {
                if (!disposed) setSignedIn((previous) => new Map(previous).set(accountId, auth.loggedIn));
            }, () => undefined);
        }
        return () => { disposed = true; };
    }, [open, host, engine, accountIds]);

    if (!menu) return null;
    const activeLabel = menu.active?.label ?? t('chat.composer.account.title');
    const engineName = menu.engineView.name;
    const engineMark = (className: string) => menu.engineView.logo === 'default'
        ? <ProviderLogo providerId={providerId} className={className} />
        : <EngineLogoMark logo={menu.engineView.logo} name={engineName} className={className} />;

    const handleSelect = async (accountId: string) => {
        const label = menu.accounts.find((account) => account.id === accountId)?.label ?? accountId;
        setSwitching(true);
        try {
            const result = await menu.select(accountId);
            if (result === 'switched') toast.success(t('chat.composer.account.switched', { account: label }));
            if (result === 'sign-in-required') {
                toast.error(t('chat.composer.account.signInPrompt', { account: label }));
                setSigningIn(accountId);
            }
        } catch (reason: unknown) {
            toast.error(reason instanceof Error ? reason.message : t('engines.accounts.failed'));
        } finally {
            setSwitching(false);
        }
    };

    return (
        <>
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={switching}
                        className={cn(
                            'model-controls__account-trigger flex min-w-0 flex-shrink-0 items-center gap-1 rounded-md select-none cursor-pointer text-foreground hover:opacity-70 disabled:cursor-default disabled:opacity-50 focus-visible:bg-[var(--interactive-hover)]',
                            heightClass,
                        )}
                        aria-label={t('chat.composer.account.triggerAria', { engine: engineName, account: activeLabel })}
                        title={t('engines.accounts.info')}
                        data-testid="composer-account-control"
                    >
                        {engineMark(cn(iconSizeClass, 'flex-shrink-0'))}
                        {isMobile ? null : (
                            <span dir="auto" className={cn('max-w-[120px] truncate text-muted-foreground', textClass)}>{engineName} ·</span>
                        )}
                        <span dir="auto" className={cn('truncate font-medium', isMobile ? 'max-w-[72px]' : 'max-w-[140px]', textClass)}>
                            {activeLabel}
                        </span>
                        {isMobile ? null : <Icon name="arrow-down-s" className="size-3.5 flex-shrink-0 opacity-60" aria-hidden="true" />}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-[min(300px,calc(100vw-2rem))] overflow-y-auto">
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                        {engineMark('size-3.5 flex-shrink-0')}
                        <span dir="auto" className="truncate">{t('chat.composer.account.groupTitle', { engine: engineName })}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={menu.active?.id ?? ''}>
                        {menu.accounts.map((account) => (
                            <DropdownMenuRadioItem
                                key={account.id}
                                value={account.id}
                                label={account.label}
                                closeOnClick
                                onClick={() => void handleSelect(account.id)}
                                className={isMobile ? 'min-h-11' : 'py-1.5'}
                            >
                                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                                    <span dir="auto" className="typography-ui-label truncate font-medium text-foreground">{account.label}</span>
                                    {account.isDefault ? <span className="typography-micro text-muted-foreground">{t('engines.accounts.default')}</span> : null}
                                    {signedIn.get(account.id) === false ? (
                                        <span className="typography-micro text-[var(--status-warning)]">{t('chat.composer.account.signInRequired')}</span>
                                    ) : null}
                                </span>
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                    <p className="typography-micro px-2 pb-1.5 pt-1 text-muted-foreground">{t('engines.accounts.info')}</p>
                </DropdownMenuContent>
            </DropdownMenu>
            {signingIn ? (
                <EngineSignInDialog
                    engine={menu.engine}
                    accountId={signingIn}
                    onClose={() => {
                        setSigningIn(null);
                        setSignedIn(new Map());
                    }}
                />
            ) : null}
        </>
    );
};
