import React from 'react';

export type CodeRunControls = {
  label: string;
  runningLabel: string;
  succeededLabel: string;
  failedLabel: string;
  run: (command: string) => Promise<boolean>;
};

const RUNNABLE_CODE_LANGUAGES = new Set(['bash', 'sh', 'zsh', 'shell']);

export const isRunnableShellLanguage = (language: string): boolean => RUNNABLE_CODE_LANGUAGES.has(language.trim().toLowerCase());

export const CodeRunContext = React.createContext<CodeRunControls | undefined>(undefined);
