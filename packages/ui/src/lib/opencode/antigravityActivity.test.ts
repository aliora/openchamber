import { describe, expect, test } from 'bun:test';

import { parseAntigravityActivityTrace } from './antigravityActivity';

const marker = (activity: Record<string, unknown>) => `⟦agy-tool⟧${JSON.stringify(activity)}`;

describe('Antigravity activity trace parser', () => {
    test('separates tool lifecycle markers from ordinary reasoning and keeps the latest state per step', () => {
        const trace = [
            'Checking the project files.',
            marker({ id: 'step-2', tool: 'write_to_file', status: 'running', summary: 'C:\\p\\hello.txt' }),
            marker({ id: 'step-2', tool: 'write_to_file', status: 'completed', summary: 'C:\\p\\hello.txt' }),
            'The file is ready.',
        ].join('\n');

        expect(parseAntigravityActivityTrace(trace)).toEqual([
            { type: 'text', text: 'Checking the project files.' },
            { type: 'activity', activity: { id: 'step-2', tool: 'write_to_file', status: 'completed', summary: 'C:\\p\\hello.txt' } },
            { type: 'text', text: 'The file is ready.' },
        ]);
    });

    test('preserves invalid or unrelated markers as ordinary reasoning text', () => {
        const malformed = '⟦agy-tool⟧not-json';
        const trace = `Thinking\n${malformed}\n${marker({ id: 'x', tool: 'run_command', status: 'unknown' })}`;

        expect(parseAntigravityActivityTrace(trace)).toEqual([{ type: 'text', text: trace }]);
    });

    test('includes a short provider error on the activity row', () => {
        expect(parseAntigravityActivityTrace(marker({
            id: 'step-8', tool: 'run_command', status: 'error', error: 'permission check failed',
        }))).toEqual([
            { type: 'activity', activity: { id: 'step-8', tool: 'run_command', status: 'error', error: 'permission check failed' } },
        ]);
    });
});
