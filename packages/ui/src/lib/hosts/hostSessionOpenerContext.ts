import React from 'react';

import { hostSessionOpener, type HostSessionOpener } from './open-host-session';

export const HostSessionOpenerContext = React.createContext<HostSessionOpener>(hostSessionOpener);

export const useHostSessionOpener = (): HostSessionOpener => React.useContext(HostSessionOpenerContext);
