import { describe, it, expect } from 'bun:test';
import { resolveClaudeExecutable } from './platform.js';

describe('PlatformResolver', () => {
  it('resolves claude executable on current system', () => {
    const res = resolveClaudeExecutable();
    expect(res).toBeDefined();
    expect(res.command.length).toBeGreaterThan(0);
  });

  it('detects platform correctly when specified', () => {
    const winRes = resolveClaudeExecutable({ platform: 'win32' });
    expect(winRes.command.toLowerCase()).toMatch(/claude(\.(cmd|exe))?$/);

    const macRes = resolveClaudeExecutable({ platform: 'darwin' });
    expect(macRes.command).toMatch(/claude$/);

    const linuxRes = resolveClaudeExecutable({ platform: 'linux' });
    expect(linuxRes.command).toMatch(/claude$/);
  });
});
