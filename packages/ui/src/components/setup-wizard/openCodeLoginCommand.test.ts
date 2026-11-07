import { describe, expect, test } from 'bun:test';
import { openCodeLoginCommand } from './openCodeLoginCommand';

describe('OpenCode terminal login', () => {
  test('uses the selected v2 binary on Mac instead of PATH v1', () => {
    expect(openCodeLoginCommand('/Users/p/.opencode/bin/opencode', 'auto')).toBe("env '/Users/p/.opencode/bin/opencode' auth login");
  });
  test('quotes a Windows path for the default PowerShell', () => {
    expect(openCodeLoginCommand('C:\\Users\\A B\\opencode.exe', 'auto')).toBe("& 'C:\\Users\\A B\\opencode.exe' auth login");
  });
  test('supports cmd explicitly', () => {
    expect(openCodeLoginCommand('C:\\A B\\opencode.exe', 'cmd')).toBe('"C:\\A B\\opencode.exe" auth login');
  });
});
