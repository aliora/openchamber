/**
 * The composer's footer row.
 *
 * Desktop lays it out as attachments, the expand and goal toggles and the
 * Permission menu on the left, the Effort and Model menus, dictation and send
 * on the right. Mobile keeps everything on one line and swaps the model and
 * effort controls for the compact buttons above the text, because the footer
 * has to stay reachable with one thumb. The row is a size container
 * (`composer-footer`): below its width threshold the Permission label
 * collapses to its icon (index.css), the way the model controls collapse
 * theirs.
 *
 * The dictation component is rendered here on desktop only: on mobile it lives
 * at the composer wrapper level so a recording started from the collapsed pill
 * survives the expand.
 */

import type { SourceControlProvider } from '@/lib/api/types';
import React from 'react';

import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Icon } from '@/components/icon/Icon';
import type { GuestAttachItem } from '@/hooks/useGuestSurfaces';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { ModelControls } from '../../ModelControls';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';
import { PermissionAutoAcceptButton } from './PermissionAutoAcceptButton';
import { EnginePermissionControl } from './EnginePermissionControl';
import type { ComposerPermission } from '../state/useComposerPermission';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';
import type { BtwSelection } from '@/stores/useBtwStore';

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);

interface ComposerFooterProps {
    isMobile: boolean;
    isVSCode: boolean;
    sessionId: string | null;
    newSessionDraftOpen: boolean;

    radius: string;
    footerPaddingClass: string;
    footerGapClass: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;

    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    permissionMode: PermissionMode;
    isPermissionAutoAcceptInteractive: boolean;
    /** The engine permission mode, or `shield` on a server without engines. */
    composerPermission: ComposerPermission;
    dictationActive: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onPickMedia?: () => void;
    onOpenGitHubPicker: () => void;
    /** The host the project's issues and change requests come from. */
    repositoryProvider?: SourceControlProvider;
    showLinearPicker?: boolean;
    onOpenLinearPicker?: () => void;
    attachGuests?: readonly GuestAttachItem[];
    onOpenGuestAttach?: (guestId: string) => void;
    onOpenAttachSheet: () => void;
    onCyclePermissionMode: () => void;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
    onStartDictation: () => void;
    onDictationInsert: (text: string) => void;
    onDictationInsertAndSend: (text: string) => void;
    onDictationSendStart: () => void;
    onDictationStart: () => void;
    onDictationContentHeightChange: (height: number | null) => void;
    /** Desktop only: the composer box hides its other contents while the overlay is up. */
    onDictationActiveChange?: (active: boolean) => void;
    isBtw?: boolean;
    modelSessionId?: string | null;
    btwSelection: BtwSelection;
    /** A pinned column's own model, agent and effort (see pinnedComposerSelection.ts). */
    pinnedSelection?: BtwSelection | null;
    /** Offers "Run on several models" in the model picker (desktop). */
    onRunInParallel?: () => void;
    /** Set while the composer is in "Run in parallel" mode: the primary action launches the run. */
    parallelRun?: { runCount: number; launching: boolean; onLaunch: () => void } | null;
    /** A sent message is held until OpenCode's first connection. */
    waitingForOpenCode: boolean;
}

/** Quiet note beside the send button while a sent message waits for OpenCode to start. */
function OpenCodeStartupNote({ className }: { className?: string }) {
    const { t } = useI18n();
    return (
        <span
            role="status"
            className={cn('min-w-0 truncate self-center typography-micro text-muted-foreground/70', className)}
            title={t('chat.chatInput.waitingForOpenCodeHint')}
        >
            {t('chat.chatInput.waitingForOpenCode')}
        </span>
    );
}

function ComposerFooterView(props: ComposerFooterProps) {
    const { t } = useI18n();
    const {
        isMobile,
        isVSCode,
        sessionId: currentSessionId,
        newSessionDraftOpen,
        radius: chatInputRadius,
        footerPaddingClass,
        footerGapClass,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        permissionMode,
        isPermissionAutoAcceptInteractive,
        composerPermission,
        dictationActive,
        onOpenSettings,
        onPickLocalFiles,
        onPickMedia,
        onOpenGitHubPicker,
        repositoryProvider,
        showLinearPicker,
        onOpenLinearPicker,
        attachGuests,
        onOpenGuestAttach,
        onOpenAttachSheet,
        onCyclePermissionMode,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
        onStartDictation,
        onDictationInsert,
        onDictationInsertAndSend,
        onDictationSendStart,
        onDictationStart,
        onDictationContentHeightChange,
        onDictationActiveChange,
        isBtw = false,
        modelSessionId,
        btwSelection,
        pinnedSelection = null,
        onRunInParallel,
        parallelRun = null,
        waitingForOpenCode,
    } = props;

    // On a server with engines the engine's mode is the permission control.
    // The BTW composer offers none there: its fork is not a session yet.
    const renderPermissionControl = (withTooltip: boolean) => {
        if (composerPermission.kind === 'shield') {
            return (
                <PermissionAutoAcceptButton
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    isInteractive={isPermissionAutoAcceptInteractive}
                    permissionMode={permissionMode}
                    handlePermissionModeCycle={onCyclePermissionMode}
                    withTooltip={withTooltip}
                />
            );
        }
        if (isBtw) return null;
        return (
            <EnginePermissionControl
                permission={composerPermission}
                isMobile={isMobile}
                heightClass={isMobile ? 'h-8' : isVSCode ? 'h-6' : 'h-8'}
                iconSizeClass={iconSizeClass}
                textClass={isMobile ? 'typography-micro' : 'typography-meta'}
            />
        );
    };

    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const [dictationSupported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
    const showDictation = dictationEnabled && dictationSupported;

    return (
        <div
            className={cn(
                'bg-transparent flex-shrink-0',
                footerPaddingClass,
                '@container/composer-footer',
                isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
            )}
            style={{
                borderBottomLeftRadius: chatInputRadius,
                borderBottomRightRadius: chatInputRadius,
            }}
            data-chat-input-footer="true"
            // On the path from the composer box to the desktop dictation
            // overlay (see the .oc-dictation-overlay rule in design-system.css).
            data-dictation-chain={isMobile ? undefined : 'true'}
        >
            {isMobile ? (
                <>
                    <div className="flex w-full items-center justify-between gap-x-1.5">
                        <div className="composer-mobile-actions flex items-center gap-x-2 ps-1">
                            <ComposerAttachmentControls
                                isVSCode={isVSCode}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                handlePickLocalFiles={onPickLocalFiles}
                                openGitHubPicker={onOpenGitHubPicker}
                                repositoryProvider={repositoryProvider}
                                showLinearPicker={showLinearPicker}
                                openLinearPicker={onOpenLinearPicker}
                                onOpenSettings={isBtw ? undefined : onOpenSettings}
                                onOpenMobileSheet={onOpenAttachSheet}
                                attachGuests={attachGuests}
                                onOpenGuestAttach={onOpenGuestAttach}
                                filesOnly={isBtw}
                            />
                            {composerPermission.kind === 'engine' ? null : renderPermissionControl(false)}
                        </div>
                        <div className="flex items-center min-w-0 gap-x-1 justify-end">
                            {waitingForOpenCode ? <OpenCodeStartupNote /> : null}
                            <div className="flex items-center gap-x-1 flex-shrink-0">
                                {!isBtw && showDictation ? <button
                                    type="button"
                                    className={footerIconButtonClass}
                                    // Keep the soft keyboard open (same guard as
                                    // PermissionAutoAcceptButton); the recording
                                    // engine lives in the wrapper-level
                                    // ComposerDictation instance.
                                    onMouseDown={(event) => event.preventDefault()}
                                    onPointerDownCapture={(event) => {
                                        if (event.pointerType === 'touch') {
                                            event.preventDefault();
                                        }
                                    }}
                                    onClick={onStartDictation}
                                    disabled={dictationActive}
                                    title={t('chat.dictation.start')}
                                    aria-label={t('chat.dictation.start')}
                                >
                                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                                </button> : null}
                                <ComposerActionButtons
                                    isMobile={isMobile}
                                    footerIconButtonClass={footerIconButtonClass}
                                    sendIconSizeClass={sendIconSizeClass}
                                    stopIconSizeClass={stopIconSizeClass}
                                    canSend={canSend}
                                    canAbort={canAbort}
                                    hasContent={hasContent}
                                    currentSessionId={currentSessionId}
                                    newSessionDraftOpen={newSessionDraftOpen}
                                    onPrimaryAction={onPrimaryAction}
                                    onQueueMessage={onQueueMessage}
                                    onAbort={onAbort}
                                />
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                        <ComposerAttachmentControls
                            isVSCode={isVSCode}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            handlePickLocalFiles={onPickLocalFiles}
                            handlePickMedia={onPickMedia}
                            openGitHubPicker={onOpenGitHubPicker}
                            repositoryProvider={repositoryProvider}
                            showLinearPicker={showLinearPicker}
                            openLinearPicker={onOpenLinearPicker}
                            onOpenSettings={isBtw ? undefined : onOpenSettings}
                            attachGuests={attachGuests}
                            onOpenGuestAttach={onOpenGuestAttach}
                            filesOnly={isBtw}
                        />
                        {renderPermissionControl(true)}
                    </div>
                    <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')} data-dictation-chain="true">
                        {waitingForOpenCode ? <OpenCodeStartupNote className="flex-shrink-0" /> : null}
                        {parallelRun ? <div className="flex-1" /> : isBtw ? <ModelControls className="flex-1 min-w-0 justify-end" sessionId={modelSessionId ?? null} selection={btwSelection} /> : pinnedSelection ? <ModelControls className="flex-1 min-w-0 justify-end" sessionId={currentSessionId} selection={pinnedSelection} agentSelectable /> : <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} onRunInParallel={onRunInParallel} />}
                        {!isBtw ? <MemoComposerDictation
                            radius={chatInputRadius}
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            footerPaddingClass={footerPaddingClass}
                            iconSizeClass={iconSizeClass}
                            sendIconSizeClass={sendIconSizeClass}
                            onInsert={onDictationInsert}
                            onInsertAndSend={onDictationInsertAndSend}
                            onSendStart={onDictationSendStart}
                            onStart={onDictationStart}
                            onContentHeightChange={onDictationContentHeightChange}
                            onActiveChange={onDictationActiveChange}
                        /> : null}
                        {parallelRun ? (
                            // Parallel mode keeps the ordinary send button: the strip above
                            // already shows how many runs start, and submitting the form
                            // launches them (ChatInput routes the submit to the run).
                            <ComposerActionButtons
                                isMobile={isMobile}
                                footerIconButtonClass={footerIconButtonClass}
                                sendIconSizeClass={sendIconSizeClass}
                                stopIconSizeClass={stopIconSizeClass}
                                canSend={canSend && parallelRun.runCount >= 2 && !parallelRun.launching}
                                canAbort={false}
                                hasContent={hasContent}
                                currentSessionId={currentSessionId}
                                newSessionDraftOpen={newSessionDraftOpen}
                                onPrimaryAction={parallelRun.onLaunch}
                                onQueueMessage={onQueueMessage}
                                onAbort={onAbort}
                                sendLabel={t('chat.parallel.runAria', { count: parallelRun.runCount })}
                            />
                        ) : <ComposerActionButtons
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            sendIconSizeClass={sendIconSizeClass}
                            stopIconSizeClass={stopIconSizeClass}
                            canSend={canSend}
                            canAbort={canAbort}
                            hasContent={hasContent}
                            currentSessionId={currentSessionId}
                            newSessionDraftOpen={newSessionDraftOpen}
                            onPrimaryAction={onPrimaryAction}
                            onQueueMessage={onQueueMessage}
                            onAbort={onAbort}
                        />}
                    </div>
                </>
            )}
        </div>
    );
}

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const ComposerFooter = React.memo(ComposerFooterView);
