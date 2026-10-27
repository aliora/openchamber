import React from 'react';
import { hostOrderKeys } from '@/lib/hosts/host-order';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { EngineLogo } from '@/lib/engineAppearance';
import { useUIStore } from '@/stores/useUIStore';

/** The logo the user picked for a host, kept under the host's server id (else its label) so it follows the profile to every device. */
export const useHostLogo = (host: { id: string; label: string } | null) => {
  const serverId = useHostsStore((state) => (host ? state.serverIdByHostId.get(host.id) ?? null : null));
  const logos = useUIStore((state) => state.hostLogos);
  const setHostLogo = useUIStore((state) => state.setHostLogo);
  const label = host?.label ?? '';

  return React.useMemo(() => {
    const keys = host ? hostOrderKeys({ descriptor: { label }, serverId }) : [];
    const logo: EngineLogo = keys.map((key) => logos[key]).find(Boolean) ?? 'default';
    return {
      logo,
      setLogo: (next: EngineLogo) => {
        for (const key of keys.slice(1)) setHostLogo(key, 'default');
        if (keys[0]) setHostLogo(keys[0], next);
      },
    };
  }, [host, label, serverId, logos, setHostLogo]);
};
