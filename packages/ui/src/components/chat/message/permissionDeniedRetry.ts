import type { Message, Part } from '@/lib/opencode/model';
import { flattenUserTextParts } from '@/lib/messages/messageText';

export const ANTIGRAVITY_ENGINE = 'antigravity';
export const ANTIGRAVITY_FULL_PERMISSION_MODE = 'dangerously-skip-permissions';

export const offersFullPermissionRetry = (engine: string | undefined, errorType: string | undefined): boolean => (
  engine === ANTIGRAVITY_ENGINE && errorType === 'PermissionDenied'
);

export const findPromptBefore = (
  messages: ReadonlyArray<Pick<Message, 'id' | 'role'>>,
  messageId: string,
  partsOf: (messageId: string) => Part[],
): string | null => {
  const index = messages.findIndex((message) => message.id === messageId);
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const message = messages[candidate];
    if (message.role === 'user') return flattenUserTextParts(partsOf(message.id)) || null;
  }
  return null;
};

export const hasPromptAfter = (
  messages: ReadonlyArray<Pick<Message, 'id' | 'role'>>,
  messageId: string,
): boolean => {
  const index = messages.findIndex((message) => message.id === messageId);
  return index !== -1 && messages.slice(index + 1).some((message) => message.role === 'user');
};
