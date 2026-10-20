import { describe, expect, it } from 'bun:test';
import { createAntigravityEngine } from './antigravity/adapter.js';
import { createClaudeEngine } from './claude/adapter.js';
import { createCodexEngine } from './codex/adapter.js';
import { inheritPermissionMode, permissionTier } from './permission-tiers.js';
import { createFakeEngine } from './test/fake-engine.js';

const installer = createFakeEngine().installer;
const signedOut = async () => ({ loggedIn: false });
const claude = createClaudeEngine({ installer, authStatusProvider: signedOut });
const codex = createCodexEngine({ installer, authStatusProvider: signedOut });
const antigravity = createAntigravityEngine({ installer, authStatusProvider: signedOut });

describe('permission tiers', () => {
  it('places every mode of the built-in engines on one ladder', () => {
    expect(claude.permissionModeTiers).toEqual({
      plan: 'read', manual: 'ask', dontAsk: 'ask', acceptEdits: 'edits', auto: 'auto', bypassPermissions: 'full',
    });
    expect(codex.permissionModeTiers).toEqual({
      'read-only': 'read', untrusted: 'ask', 'on-request': 'auto', never: 'auto', 'full-access': 'full',
    });
    expect(antigravity.permissionModeTiers).toEqual({
      default: 'read', 'accept-edits': 'edits', auto: 'auto', 'dangerously-skip-permissions': 'full',
    });
    expect(permissionTier(claude, 'plan')).toBeLessThan(permissionTier(claude, 'manual'));
    expect(permissionTier(codex, 'full-access')).toBe(permissionTier(antigravity, 'dangerously-skip-permissions'));
    expect(permissionTier(claude, 'missing')).toBe(-1);
  });

  it('keeps the mode on the same engine', () => {
    expect(inheritPermissionMode('acceptEdits', claude, claude)).toBe('acceptEdits');
    expect(inheritPermissionMode('never', codex, codex)).toBe('never');
  });

  it('takes the most permissive mode of another engine that stays within the tier', () => {
    expect(inheritPermissionMode('read-only', codex, claude)).toBe('plan');
    expect(inheritPermissionMode('untrusted', codex, claude)).toBe('manual');
    expect(inheritPermissionMode('acceptEdits', claude, codex)).toBe('untrusted');
    expect(inheritPermissionMode('auto', claude, codex)).toBe('on-request');
    expect(inheritPermissionMode('manual', claude, antigravity)).toBe('default');
    expect(inheritPermissionMode('bypassPermissions', claude, antigravity)).toBe('dangerously-skip-permissions');
  });

  it('falls back to the least permissive mode when nothing fits', () => {
    expect(inheritPermissionMode('plan', claude, createFakeEngine())).toBe('ask');
    expect(inheritPermissionMode('unknown', claude, codex)).toBe('read-only');
  });
});
