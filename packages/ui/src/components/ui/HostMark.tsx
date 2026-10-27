import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useHostLogo } from '@/hooks/useHostLogo';
import { EngineLogoMark } from './EngineLogoMark';

interface HostMarkProps {
    host: { id: string; label: string } | null;
    defaultIcon: IconName;
    className?: string;
}

export const HostMark: React.FC<HostMarkProps> = ({ host, defaultIcon, className }) => {
    const { logo } = useHostLogo(host);
    return logo === 'default'
        ? <Icon name={defaultIcon} className={className} />
        : <EngineLogoMark logo={logo} name={host?.label ?? ''} className={className} />;
};
