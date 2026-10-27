import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';
import { useUIStore } from '@/stores/useUIStore';
import { customProviderIconName } from '@/lib/customProviderIcons';
import { useEngineView } from '@/hooks/useEngineView';
import { EngineLogoMark } from './EngineLogoMark';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
    /** Show the provider's own logo even when the user picked an icon for it. */
    ignoreCustomIcon?: boolean;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError,
    ignoreCustomIcon = false,
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const customIcon = useUIStore((state) => state.customProviderIcons[providerId]);
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);
    const engineView = useEngineView(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (engineView && engineView.logo !== 'default' && !ignoreCustomIcon) {
        return <EngineLogoMark logo={engineView.logo} name={engineView.name} className={className} />;
    }

    if (customIcon && !ignoreCustomIcon) {
        return <Icon name={customProviderIconName(customIcon)} className={cn('text-muted-foreground', className)} />;
    }

    if (!hasLogo || !src) {
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} /> : null;
    }

    return (
        <img
            src={src}
            alt={alt || `${providerId} logo`}
            className={cn('dark:invert object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onError={handleError}
        />
    );
};
