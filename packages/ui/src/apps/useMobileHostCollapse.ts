import React from 'react';
import { z } from 'zod';

import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const COLLAPSE_STORAGE_KEY = 'oc.mobile.hostCollapse';

const readCollapsed = (): Set<string> => {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(getDeferredSafeStorage().getItem(COLLAPSE_STORAGE_KEY) ?? '[]'));
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
};

const writeCollapsed = (collapsed: ReadonlySet<string>): void => {
  try {
    getDeferredSafeStorage().setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    return;
  }
};

/** Collapsed server sections, by host id, kept across launches. */
export const useMobileHostCollapse = () => {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(readCollapsed);
  const toggle = React.useCallback((hostId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(hostId)) next.add(hostId);
      writeCollapsed(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
};
