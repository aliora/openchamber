import { describe, expect, test } from 'bun:test';

import { rewriteLeadingSkillInvocation, rewriteSkillInvocationForSend } from './skillInvocation';

const skills = new Set(['Explore-Docs', 'review-pr', 'plan']);
const reserved = new Set(['review', 'compact', 'plan']);

const rewrite = (text: string) => rewriteLeadingSkillInvocation(text, skills, reserved);

describe('rewriteLeadingSkillInvocation', () => {
    test('a leading skill invocation becomes a dollar mention', () => {
        expect(rewrite('/review-pr')).toBe('$review-pr');
        expect(rewrite('/review-pr check the diff')).toBe('$review-pr check the diff');
    });

    test('the registry casing is used whatever the user typed', () => {
        expect(rewrite('/explore-docs find the API')).toBe('$Explore-Docs find the API');
    });

    test('a command with the same name wins over the skill', () => {
        expect(rewrite('/plan the release')).toBe('/plan the release');
    });

    test('a reserved command is matched case-insensitively', () => {
        expect(rewriteLeadingSkillInvocation('/Plan x', skills, reserved)).toBe('/Plan x');
    });

    test('an unknown name or a bare slash is unchanged', () => {
        expect(rewrite('/unknown words')).toBe('/unknown words');
        expect(rewrite('/')).toBe('/');
        expect(rewrite('/ review-pr')).toBe('/ review-pr');
    });

    test('only the leading token is rewritten', () => {
        expect(rewrite('please /review-pr this')).toBe('please /review-pr this');
        expect(rewrite('/review-pr then /explore-docs')).toBe('$review-pr then /explore-docs');
    });

    test('leading whitespace is kept', () => {
        expect(rewrite('  \n/review-pr now')).toBe('  \n$review-pr now');
    });

    test('a name that runs into other characters is not a skill invocation', () => {
        expect(rewrite('/review-pr/notes')).toBe('/review-pr/notes');
    });

    test('arguments with other dollar mentions are left alone', () => {
        expect(rewrite('/review-pr args with $plan')).toBe('$review-pr args with $plan');
    });
});

describe('rewriteSkillInvocationForSend', () => {
    test('normal mode rewrites a leading skill invocation', () => {
        expect(rewriteSkillInvocationForSend('/review-pr now', 'normal', skills, reserved)).toBe('$review-pr now');
    });

    test('shell mode sends the text untouched', () => {
        expect(rewriteSkillInvocationForSend('/review-pr now', 'shell', skills, reserved)).toBe('/review-pr now');
    });

    test('handoff-review stays a command even when the caller does not reserve it', () => {
        const withHandoffSkill = new Set([...skills, 'handoff-review']);
        expect(rewriteSkillInvocationForSend('/handoff-review', 'normal', withHandoffSkill, reserved)).toBe('/handoff-review');
    });
});
