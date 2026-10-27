import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const makeRuntime = ({ settings = {}, interactiveVisible = false } = {}) => {
  const sendPushToAllUiSessions = vi.fn(async () => undefined);
  const sendApnsToAllUiSessions = vi.fn(async () => undefined);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', ...settings }),
    buildTemplateVariables: async () => ({ session_name: 'Release prep' }),
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification: vi.fn(() => true),
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible: () => interactiveVisible,
  });
  return { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions };
};

const nightly = (state = {}) => ({ id: 'task_1', name: 'Nightly report', state });

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduled task push', () => {
  it('announces a started run and opens its session', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: nightly(), status: 'running', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions.mock.calls[0][0]).toMatchObject({
      title: 'Task started: Nightly report',
      tag: 'scheduled-ses_1',
      data: { url: '/?session=ses_1', sessionId: 'ses_1', sessionName: 'Nightly report', type: 'task_started' },
    });
    expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({
      title: 'Task started',
      body: 'Nightly report',
      tag: 'scheduled-ses_1',
      data: { sessionId: 'ses_1' },
    });
  });

  it('treats a prompt sent to an existing session as the start of the run', async () => {
    const { runtime, sendPushToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: nightly(), status: 'sent', sessionId: 'ses_2' });

    expect(sendPushToAllUiSessions.mock.calls[0][0].title).toBe('Task started: Nightly report');
  });

  it('announces a finished run with how long it took', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: nightly({ lastDurationMs: 125_000 }), status: 'success', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions.mock.calls[0][0]).toMatchObject({
      title: 'Task finished: Nightly report',
      body: 'Finished in 2m 5s',
      data: { type: 'task_finished', sessionId: 'ses_1' },
    });
    expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ title: 'Task finished', body: 'Nightly report' });
  });

  it('announces a failed run with its error', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: nightly({ lastError: 'model unavailable' }), status: 'error', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions.mock.calls[0][0]).toMatchObject({
      title: 'Task failed: Nightly report',
      body: 'Failed: model unavailable',
      data: { type: 'task_failed' },
    });
    expect(sendApnsToAllUiSessions.mock.calls[0][0].title).toBe('Task failed');
  });

  it('opens the app when a failed run has no session', async () => {
    const { runtime, sendPushToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: nightly(), status: 'failed' });

    const push = sendPushToAllUiSessions.mock.calls[0][0];
    expect(push.title).toBe('Task failed: Nightly report');
    expect(push.data.url).toBe('/');
    expect(push.data.sessionId).toBeUndefined();
    expect(push.tag).toBe('scheduled-task_1');
  });

  it('stays quiet for runs that only waited in the queue or were skipped', async () => {
    const { runtime, sendPushToAllUiSessions } = makeRuntime();

    for (const status of ['queued', 'skipped', 'cancelled']) {
      await runtime.sendScheduledTaskPush({ task: nightly(), status, sessionId: 'ses_1' });
    }

    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('stays quiet when scheduled task notifications are off', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime({ settings: { notifyOnScheduledTask: false } });

    await runtime.sendScheduledTaskPush({ task: nightly(), status: 'running', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('stays quiet for a task whose notifications are off', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime();

    await runtime.sendScheduledTaskPush({ task: { ...nightly(), notify: false }, status: 'failed', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips the phone while a desktop client is visible, like every other push', async () => {
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime({ interactiveVisible: true });

    await runtime.sendScheduledTaskPush({ task: nightly(), status: 'success', sessionId: 'ses_1' });

    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });
});

const permissionAsked = {
  type: 'permission.asked',
  properties: { sessionID: 'ses_p', id: 'per_1', action: 'bash', resources: ['rm -rf build'] },
};

const askPermission = async (settings) => {
  vi.useFakeTimers();
  const { runtime, sendPushToAllUiSessions } = makeRuntime({ settings });
  await runtime.maybeSendPushForTrigger(permissionAsked);
  await vi.advanceTimersByTimeAsync(600);
  return sendPushToAllUiSessions;
};

describe('permission push toggle', () => {
  it('follows its own setting when questions are off', async () => {
    const push = await askPermission({ notifyOnQuestion: false, notifyOnPermission: true });
    expect(push.mock.calls[0][0].data).toMatchObject({ type: 'permission', sessionId: 'ses_p' });
  });

  it('stays quiet when permissions are off even with questions on', async () => {
    const push = await askPermission({ notifyOnQuestion: true, notifyOnPermission: false });
    expect(push).not.toHaveBeenCalled();
  });

  it('falls back to the question setting when it was never set', async () => {
    expect(await askPermission({ notifyOnQuestion: false })).not.toHaveBeenCalled();
    expect(await askPermission({ notifyOnQuestion: true })).toHaveBeenCalledTimes(1);
  });
});
