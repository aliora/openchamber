import { isEngineId, type EngineId } from '@/components/setup-wizard/engineSetupModel';

const CLAUDE_SIGNED_OUT = /Not logged in|Please run \/login/;

export const isSignInError = (errorType: string | undefined, errorText: string | undefined): boolean =>
  errorType === 'AuthRequired' || CLAUDE_SIGNED_OUT.test(errorText ?? '');

export const signInEngineForError = (engine: string | undefined, errorType: string | undefined, errorText: string | undefined): EngineId | null => {
  if (!isEngineId(engine) || !isSignInError(errorType, errorText)) return null;
  return errorType === 'AuthRequired' || engine === 'claude' ? engine : null;
};
