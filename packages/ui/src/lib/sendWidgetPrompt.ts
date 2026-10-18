import { resolveSessionSendConfig } from '@/hooks/useQueuedMessageAutoSend';
import { useSessionUIStore } from '@/sync/session-ui-store';

export async function sendWidgetPrompt(sessionId: string, text: string): Promise<void> {
    const store = useSessionUIStore.getState();
    const directory = store.getDirectoryForSession(sessionId) ?? undefined;
    const { providerID, modelID, agent, variant } = resolveSessionSendConfig(sessionId);
    if (!providerID || !modelID) throw new Error('No model is selected for this session');
    await store.sendMessage(text, providerID, modelID, agent, undefined, undefined, undefined, variant, 'normal', { sessionId, directory });
}
