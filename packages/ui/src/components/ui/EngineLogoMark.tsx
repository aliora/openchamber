import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { engineLogoDotColor, engineLogoIconName, type EngineLogo } from '@/lib/engineAppearance';
import { cn } from '@/lib/utils';

interface EngineLogoMarkProps {
    logo: EngineLogo;
    name: string;
    className?: string;
}

export const EngineLogoMark: React.FC<EngineLogoMarkProps> = ({ logo, name, className }) => {
    const iconName = engineLogoIconName(logo);
    if (iconName) {
        return <Icon name={iconName} className={cn('text-muted-foreground', className)} />;
    }

    const dotColor = engineLogoDotColor(logo);
    if (dotColor) {
        return (
            <span aria-hidden className={cn('inline-block', className)}>
                <span className="block size-full scale-[0.62] rounded-full" style={{ background: dotColor }} />
            </span>
        );
    }

    return (
        <span
            aria-hidden
            className={cn('inline-flex items-center justify-center rounded-[3px] bg-muted-foreground/25 font-semibold leading-none text-muted-foreground', className)}
            style={{ containerType: 'size' }}
        >
            <span style={{ fontSize: '62cqh' }}>{name.trim().charAt(0).toUpperCase()}</span>
        </span>
    );
};
