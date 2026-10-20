import { useComposerPermission } from '../state/useComposerPermission';
import { EnginePermissionControl } from './EnginePermissionControl';

interface SubSessionPermissionControlProps {
    sessionId: string;
    isMobile: boolean;
}

export const SubSessionPermissionControl = ({ sessionId, isMobile }: SubSessionPermissionControlProps) => {
    const permission = useComposerPermission({ sessionId, draftOpen: false, providerId: null });
    if (permission.kind === 'shield') return null;

    return (
        <div className="-my-1.5 -ms-1 flex shrink-0">
            <EnginePermissionControl
                permission={permission}
                isMobile={isMobile}
                heightClass="h-8"
                iconSizeClass="size-4"
                textClass={isMobile ? 'hidden' : 'typography-ui-label'}
            />
        </div>
    );
};
