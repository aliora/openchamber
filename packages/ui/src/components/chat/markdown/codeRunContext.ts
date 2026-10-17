import React from 'react';
import type { CodeRunControls } from './decorate';

export const CodeRunContext = React.createContext<CodeRunControls | undefined>(undefined);
