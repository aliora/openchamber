import { afterEach, expect, test } from 'bun:test';
import { setDraftEngineAccount } from '@/lib/engineAccounts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readGenerationScope } from './useSessionEngineAccount';

const sessionId = useSessionUIStore.getState().currentSessionId;
const providerId = useConfigStore.getState().currentProviderId;
const catalog = useEngineControlsStore.getState().catalog;

afterEach(() => {
  setDraftEngineAccount('claude', null);
  useSessionUIStore.setState({ currentSessionId: sessionId });
  useConfigStore.setState({ currentProviderId: providerId });
  useEngineControlsStore.setState({ catalog });
});

test('a generation runs for the open session, else for the account a draft picked, else for the host default', () => {
  useEngineControlsStore.setState({ catalog: { defaultEngine: 'claude', engines: [{ engine: 'claude', providerID: 'claude-provider', defaultPermissionMode: 'ask', permissionModes: [], defaultEffort: null }] } });
  useConfigStore.setState({ currentProviderId: 'claude-provider' });
  useSessionUIStore.setState({ currentSessionId: 'ses_work' });
  setDraftEngineAccount('claude', 'acc-personal');
  expect(readGenerationScope()).toEqual({ sessionID: 'ses_work' });
  useSessionUIStore.setState({ currentSessionId: null });
  expect(readGenerationScope()).toEqual({ account: 'claude:acc-personal' });
  setDraftEngineAccount('claude', null);
  expect(readGenerationScope()).toEqual({});
});
