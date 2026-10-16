import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough, Writable } from 'node:stream';

/** A recorded `codex app-server` transcript from `test/codex/<name>.ndjson`. */
export const readCodexTranscript = (name) => fs.readFileSync(new URL(`./codex/${name}.ndjson`, import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const answers = (step, message) => (step.await === 'response'
  ? message.id === step.id && message.method === undefined
  : message.method === step.await);

/**
 * A stand-in for the `codex app-server` child process that plays a transcript.
 * `{"await": "<method>"}` waits until the client sends that method, and
 * `{"await": "response", "id": N}` until it answers server request N. Every
 * other line goes to the client as written. `sent` holds what the client wrote.
 */
export const createFakeCodexChild = (transcript) => {
  const child = new EventEmitter();
  const sent = [];
  const used = new Set();
  let cursor = 0;
  let pending = '';

  const play = () => {
    while (cursor < transcript.length) {
      const step = transcript[cursor];
      if (step.await) {
        const index = sent.findIndex((message, i) => !used.has(i) && answers(step, message));
        if (index === -1) return;
        used.add(index);
      } else {
        child.stdout.write(`${JSON.stringify(step)}\n`);
      }
      cursor += 1;
    }
  };

  Object.assign(child, {
    sent,
    killed: false,
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, encoding, callback) {
        pending += chunk.toString();
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          sent.push(JSON.parse(pending.slice(0, newline)));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        play();
        callback();
      },
    }),
    kill(signal) {
      child.killed = true;
      setImmediate(() => child.exit(null, signal));
      return true;
    },
    exit(code, signal = null) {
      child.exitCode = code;
      child.emit('exit', code, signal);
    },
  });

  // True once every line of the transcript was played.
  Object.defineProperty(child, 'finished', { get: () => cursor === transcript.length });

  play();
  return child;
};
