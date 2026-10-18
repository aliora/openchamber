import { describe, expect, test } from 'bun:test';
import { signInEngineForError } from './engineSignIn';

describe('signInEngineForError', () => {
  test('offers sign-in for a typed not-signed-in failure of any engine', () => {
    expect(signInEngineForError('codex', 'AuthRequired', 'Codex is not signed in')).toBe('codex');
    expect(signInEngineForError('claude', 'AuthRequired', undefined)).toBe('claude');
    expect(signInEngineForError('antigravity', 'AuthRequired', undefined)).toBe('antigravity');
  });

  test('recognises the untyped Claude error an older server still sends', () => {
    expect(signInEngineForError('claude', 'api_error', 'Not logged in · Please run /login')).toBe('claude');
  });

  test('ignores other failures and sessions without a known engine', () => {
    expect(signInEngineForError('claude', 'api_error', 'API Error: 529 Overloaded')).toBeNull();
    expect(signInEngineForError('antigravity', 'PermissionDenied', undefined)).toBeNull();
    expect(signInEngineForError(undefined, 'AuthRequired', undefined)).toBeNull();
  });
});
