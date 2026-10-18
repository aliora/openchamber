import { EventEmitter } from 'node:events';

export const createFakeSpawn = () => {
  const calls = [];
  const children = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  const finish = (code = 0, output = '') => {
    const child = children.at(-1);
    if (output) child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code);
  };
  return { calls, children, spawnProcess, finish };
};

export const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
