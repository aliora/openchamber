const LEADING_SLASH_TOKEN = /^(\s*)\/([A-Za-z0-9][A-Za-z0-9_-]*)(?=\s|$)/;

/**
 * Turns a leading `/skill` into the `$Skill` mention the send path already
 * understands. Commands keep their slash: a name in `reservedCommandNames`
 * is never rewritten.
 */
export const rewriteLeadingSkillInvocation = (
    text: string,
    skillNames: ReadonlySet<string>,
    reservedCommandNames: ReadonlySet<string>,
): string => {
    const match = LEADING_SLASH_TOKEN.exec(text);
    if (!match) return text;

    const [token, leadingWhitespace, typedName] = match;
    const lowerName = typedName.toLowerCase();
    if (reservedCommandNames.has(lowerName) || reservedCommandNames.has(typedName)) return text;

    const skillName = [...skillNames].find((name) => name.toLowerCase() === lowerName);
    if (!skillName) return text;

    return `${leadingWhitespace}$${skillName}${text.slice(token.length)}`;
};

const ALWAYS_RESERVED_COMMAND_NAMES = ['handoff-review'];

export const rewriteSkillInvocationForSend = (
    text: string,
    inputMode: 'normal' | 'shell',
    skillNames: ReadonlySet<string>,
    reservedCommandNames: ReadonlySet<string>,
): string => {
    if (inputMode !== 'normal') return text;
    return rewriteLeadingSkillInvocation(
        text,
        skillNames,
        new Set([...reservedCommandNames, ...ALWAYS_RESERVED_COMMAND_NAMES]),
    );
};
