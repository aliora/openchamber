import { describe, expect, test } from 'bun:test';
import { resolveNewDraftProject } from './new-session-draft-project';

const alpha = { id: 'proj-a' };
const beta = { id: 'proj-b' };
const gamma = { id: 'proj-c' };
const projects = [alpha, beta, gamma];

describe('resolveNewDraftProject', () => {
  test('an explicit project wins over the default and the active project', () => {
    expect(resolveNewDraftProject({ projects, explicitProjectId: gamma.id, defaultProjectId: beta.id, activeProjectId: alpha.id })).toBe(gamma);
  });

  test('the default project wins over the active project', () => {
    expect(resolveNewDraftProject({ projects, defaultProjectId: beta.id, activeProjectId: gamma.id })).toBe(beta);
  });

  test('the active project is used when no default is set', () => {
    expect(resolveNewDraftProject({ projects, defaultProjectId: null, activeProjectId: gamma.id })).toBe(gamma);
  });

  test('a default project that no longer exists falls through to the active project', () => {
    expect(resolveNewDraftProject({ projects, defaultProjectId: 'proj-removed', activeProjectId: gamma.id })).toBe(gamma);
  });

  test('an explicit project that no longer exists falls through to the default project', () => {
    expect(resolveNewDraftProject({ projects, explicitProjectId: 'proj-removed', defaultProjectId: beta.id })).toBe(beta);
  });

  test('the first project is used when neither a default nor an active project resolves', () => {
    expect(resolveNewDraftProject({ projects, defaultProjectId: 'proj-removed', activeProjectId: 'proj-gone' })).toBe(alpha);
  });

  test('no project at all resolves to null', () => {
    expect(resolveNewDraftProject({ projects: [], defaultProjectId: beta.id, activeProjectId: alpha.id })).toBeNull();
  });
});
