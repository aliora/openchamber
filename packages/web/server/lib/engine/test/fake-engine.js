import { EventEmitter } from 'node:events';

// A scripted engine for tests: each prompt is answered by `reply(text, process)`.
// `livePermissionModes` are the modes a running process takes through
// `setPermissionMode`, which records each call and rejects while
// `adapter.permissionModeError` is set.
export const createFakeEngine = ({ id = 'fake', reply, livePermissionModes } = {}) => {
  const processes = [];
  const installerEvents = new EventEmitter();
  const adapter = {
    id,
    displayName: `Fake ${id}`,
    providerID: `${id}-provider`,
    modelCatalog: () => ({ models: [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }], defaultModel: 'fast' }),
    permissionModes: ['ask', 'yolo'],
    defaultPermissionMode: 'ask',
    permissionModeTiers: { ask: 'ask', auto: 'auto', yolo: 'full' },
    livePermissionModes,
    dangerousPermissionModes: ['yolo'],
    installer: Object.assign(installerEvents, {
      getStatus: () => ({ installed: true, version: '1.0.0', state: 'idle', canInstall: true }),
      getLogs: () => [],
      install: async () => ({ version: '1.0.0' }),
    }),
    auth: {
      status: async () => ({ loggedIn: true, email: `${id}@example.com` }),
      logout: () => {},
    },
    processes,
    createProcess: (options) => {
      const proc = new EventEmitter();
      Object.assign(proc, {
        options,
        isAlive: false,
        sent: [],
        sentAttachments: [],
        permissionReplies: [],
        start: async () => {
          // Set `adapter.startError` to make the next process fail to start.
          if (adapter.startError) throw adapter.startError;
          proc.isAlive = true;
        },
        sendUserMessage: (text, attachments = []) => {
          proc.sent.push(text);
          proc.sentAttachments.push(attachments);
          queueMicrotask(() => reply?.(text, proc));
        },
        respondPermission: (requestId, behavior) => proc.permissionReplies.push({ requestId, behavior }),
        questionReplies: [],
        respondQuestion: (requestId, answers) => proc.questionReplies.push({ requestId, answers }),
        permissionModeChanges: [],
        setPermissionMode: async (mode) => {
          if (adapter.permissionModeError) throw adapter.permissionModeError;
          proc.permissionModeChanges.push(mode);
        },
        abort: async () => {
          proc.isAlive = false;
          proc.emit('exit', { code: null, signal: 'SIGINT' });
        },
      });
      processes.push(proc);
      return proc;
    },
  };
  return adapter;
};
