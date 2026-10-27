import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ToolPart } from '@/lib/opencode/model';
import TodoChecklist from './TodoChecklist';

const part = (todos: unknown[]): ToolPart => ({
  id: 'call_todo', sessionID: 'ses', messageID: 'msg', type: 'tool', tool: 'todo', callID: 'call_todo',
  state: { status: 'completed', input: { todos } as ToolPart['state']['input'], output: '', time: { start: 1, end: 2 } },
});

describe('TodoChecklist', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('separates finished, current and waiting steps and counts the finished ones', async () => {
    await act(async () => {
      root.render(<TodoChecklist part={part([
        { content: 'Plan', status: 'completed' },
        { content: 'Build', status: 'in_progress', activeForm: 'Building' },
        { content: 'Ship', status: 'pending' },
      ])} />);
    });
    const rows = [...host.querySelectorAll('li')].map((row) => [row.getAttribute('data-status'), row.textContent]);
    expect(rows).toEqual([['completed', 'Plan'], ['in_progress', 'Building'], ['pending', 'Ship']]);
    expect(host.textContent).toContain('1/3');
  });

  test('draws nothing for an empty list', async () => {
    await act(async () => {
      root.render(<TodoChecklist part={part([])} />);
    });
    expect(host.querySelector('[data-testid="todo-checklist"]')).toBeNull();
  });
});
