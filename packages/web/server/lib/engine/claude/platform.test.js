import { describe, it, expect } from 'bun:test';
import { resolveClaudeExecutable, normalizeFsPath } from './platform.js';

describe('PlatformResolver', () => {
  it('resolves claude executable on current system', () => {
    const res = resolveClaudeExecutable();
    expect(res).toBeDefined();
    expect(typeof res.command).toBe('string');
    expect(res.command.length).toBeGreaterThan(0);
  });

  it('normalizes backslashes to forward slashes for cross-platform compatibility', () => {
    const winPath = 'C:\\Users\\alta\\Documents\\project';
    const normalized = normalizeFsPath(winPath);
    expect(normalized).toBe('C:/Users/alta/Documents/project');
  });

  it('detects platform correctly when specified', () => {
    const winRes = resolveClaudeExecutable({ platform: 'win32' });
    expect(winRes.command.toLowerCase()).toMatch(/claude(\.cmd)?$/);

    const macRes = resolveClaudeExecutable({ platform: 'darwin' });
    expect(macRes.command).toMatch(/claude$/);

    const linuxRes = resolveClaudeExecutable({ platform: 'linux' });
    expect(linuxRes.command).toMatch(/claude$/);
  });
});
