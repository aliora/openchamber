import { EventEmitter } from 'node:events';

// A scripted engine for tests: each prompt is answered by `reply(text, process)`.
export const createFakeEngine = ({ id = 'fake', reply } = {}) => {
  const processes = [];
  const installerEvents = new EventEmitter();
  const adapter = {
    id,
    displayName: `Fake ${id}`,
    providerID: `${id}-provider`,
    models: [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }],
    defaultModel: 'fast',
    permissionModes: ['ask', 'yolo'],
    defaultPermissionMode: 'ask',
    installer: Object.assign(installerEvents, {
      getStatus: () => ({ installed: true, version: '1.0.0', state: 'idle', canInstall: true }),
      getLogs: () => [],
      install: async () => ({ version: '1.0.0' }),
    }),
    auth: {
      status: async () => ({ loggedIn: true, email: `${id}@example.com` }),
      login: () => {},
      logout: () => {},
    },
    processes,
    createProcess: (options) => {
      const proc = new EventEmitter();
      Object.assign(proc, {
        options,
        isAlive: false,
        sent: [],
        permissionReplies: [],
        start: async () => {
          // Set `adapter.startError` to make the next process fail to start.
          if (adapter.startError) throw adapter.startError;
          proc.isAlive = true;
        },
        sendUserMessage: (text) => {
          proc.sent.push(text);
          queueMicrotask(() => reply?.(text, proc));
        },
        respondPermission: (requestId, behavior) => proc.permissionReplies.push({ requestId, behavior }),
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
