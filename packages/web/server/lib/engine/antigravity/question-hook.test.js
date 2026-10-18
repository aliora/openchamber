import { afterAll, describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchAgyQuestions, writeQuestionHook } from './question-hook.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ask-question-hook-input.json');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-question-hook-test-'));
afterAll(() => fs.rmSync(parent, { recursive: true, force: true }));

const makePluginDirectory = () => {
  const directory = fs.mkdtempSync(path.join(parent, 'plugin-'));
  writeQuestionHook(directory);
  return directory;
};

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
};

const runHook = (directory, input) => {
  const child = spawn('sh', ['ask-question.sh'], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })));
  child.stdin.end(input);
  return exited;
};

describe('writeQuestionHook', () => {
  it('has agy run a PreToolUse hook for ask_question with sh from the plugin folder, for up to a day', () => {
    const directory = makePluginDirectory();
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'hooks.json'), 'utf8'))).toEqual({
      'openchamber-questions': {
        PreToolUse: [{ matcher: 'ask_question', hooks: [{ type: 'command', command: 'sh ask-question.sh', timeout: 86400 }] }],
      },
    });
    expect(fs.statSync(path.join(directory, 'questions')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(directory, 'answers')).isDirectory()).toBe(true);
  });
});

describe('watchAgyQuestions', () => {
  it('reads the question agy hands the hook and prints the answer as the hook decision', async () => {
    const directory = makePluginDirectory();
    const asked = [];
    const watcher = watchAgyQuestions({ directory, onQuestion: (question) => asked.push(question), intervalMs: 10 });
    const hook = runHook(directory, fs.readFileSync(fixturePath, 'utf8'));

    expect(await waitFor(() => asked.length === 1)).toBe(true);
    expect(asked[0]).toEqual({
      id: expect.any(String),
      title: 'Color question',
      questions: [{ question: 'Which color?', options: ['Red', 'Blue'], multiple: false }],
    });

    watcher.answer(asked[0].id, { decision: 'deny', reason: 'Which color?: Blue' });
    expect(await hook).toEqual({ code: 0, stdout: '{"decision":"deny","reason":"Which color?: Blue"}' });
    expect(fs.readdirSync(path.join(directory, 'questions'))).toEqual([]);
    expect(fs.readdirSync(path.join(directory, 'answers'))).toEqual([]);
    watcher.stop();
  });

  it('lets agy go on by itself when the hook input is no question it can read', async () => {
    const directory = makePluginDirectory();
    const asked = [];
    const watcher = watchAgyQuestions({ directory, onQuestion: (question) => asked.push(question), intervalMs: 10 });

    expect(await runHook(directory, '{"toolCall":{"name":"ask_question","args":{}}}')).toEqual({ code: 0, stdout: '{}' });
    expect(asked).toEqual([]);
    watcher.stop();
  });

  it('ends a waiting hook when its plugin folder is removed', async () => {
    const directory = makePluginDirectory();
    const hook = runHook(directory, fs.readFileSync(fixturePath, 'utf8'));
    expect(await waitFor(() => fs.readdirSync(path.join(directory, 'questions')).length === 1)).toBe(true);

    fs.rmSync(directory, { recursive: true, force: true });
    expect((await hook).code).not.toBe(0);
  });
});
