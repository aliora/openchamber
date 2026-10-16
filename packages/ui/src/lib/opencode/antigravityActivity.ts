export type AntigravityToolActivity = {
    id: string;
    tool: string;
    status: 'running' | 'completed' | 'error';
    summary?: string;
    error?: string;
};

export type AntigravityActivitySegment =
    | { type: 'text'; text: string }
    | { type: 'activity'; activity: AntigravityToolActivity };

const MARKER = '⟦agy-tool⟧';
const MARKER_LINE = /^⟦agy-tool⟧([^\r\n]*)$/gm;

function parseActivityPayload(value: string): AntigravityToolActivity | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) return null;
    if (typeof record.tool !== 'string' || !record.tool.trim()) return null;
    if (record.status !== 'running' && record.status !== 'completed' && record.status !== 'error') return null;

    return {
        id: record.id,
        tool: record.tool,
        status: record.status,
        ...(typeof record.summary === 'string' && record.summary ? { summary: record.summary } : {}),
        ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    };
}

/**
 * Extracts the Antigravity bridge's structured activity lines from reasoning
 * text. Repeated updates for one provider step collapse to its latest state.
 */
export function parseAntigravityActivityTrace(text: string): AntigravityActivitySegment[] {
    const segments: AntigravityActivitySegment[] = [];
    const activityIndex = new Map<string, number>();
    const appendText = (value: string) => {
        const clean = value.replace(/^\r?\n+|\r?\n+$/g, '');
        if (!clean) return;
        const previous = segments.at(-1);
        if (previous?.type === 'text') previous.text += clean;
        else segments.push({ type: 'text', text: clean });
    };

    let cursor = 0;
    for (const match of text.matchAll(MARKER_LINE)) {
        const fullMatch = match[0];
        const offset = match.index ?? 0;
        const activity = parseActivityPayload(fullMatch.slice(MARKER.length));
        if (!activity) continue;

        appendText(text.slice(cursor, offset));
        const existingIndex = activityIndex.get(activity.id);
        if (existingIndex !== undefined) {
            segments[existingIndex] = { type: 'activity', activity };
        } else {
            activityIndex.set(activity.id, segments.length);
            segments.push({ type: 'activity', activity });
        }
        cursor = offset + fullMatch.length;
        if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
        else if (text[cursor] === '\n') cursor += 1;
    }
    appendText(text.slice(cursor));
    return segments;
}
