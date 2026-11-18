import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { HostMark } from '@/components/ui/HostMark';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { preselectRememberedDraftHost } from '@/components/chat/composer/state/useDraftHost';
import { PROJECT_ICON_MAP, resolveProjectColor } from '@/lib/projectMeta';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';
import { formatHostLabel, useHostSessionActions } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { hostProjectOrder } from '@/components/session/sidebar/hosts/remoteHostProjection';

// Like the icon rail: muted at rest, full strength on hover or while what it
// controls is on, and no hover fill.
export const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-6 w-6 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors';

const openNewSessionDraftAt = (projectId: string, directory: string): void => {
  // Starting a draft always leaves any full-page surface.
  useUIStore.getState().closeMainSurfaces();
  useProjectsStore.getState().setActiveProjectIdOnly(projectId);
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: directory });
};

/**
 * The menu of the titlebar's New session split button: a session in one
 * of the projects, adding a project first, or, on the desktop
 * while it watches other hosts, a draft on another host. The main part of the
 * button keeps opening a draft where the user is.
 */
const HostMenuEntry: React.FC<{ host: MonitoredHost; onStartOnHost: (host: HostDescriptor, directory?: string) => void }> = ({ host, onStartOnHost }) => {
  const { t } = useI18n();
  const { descriptor } = host;
  const label = <>
    <HostMark host={descriptor} defaultIcon={descriptor.kind === 'local' ? 'computer' : 'server'} className="h-4 w-4" />
    <span dir="auto" className="min-w-0 truncate">{formatHostLabel(descriptor, t)}</span>
  </>;
  const projects = host.snapshot.projects ?? [];
  if (projects.length === 0) {
    return <DropdownMenuItem onClick={() => onStartOnHost(descriptor)}>{label}</DropdownMenuItem>;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(24rem,70vh)] min-w-[200px] max-w-[18rem] overflow-y-auto">
        <DropdownMenuLabel>{t('sessions.newSession.chooseProject')}</DropdownMenuLabel>
        {[...projects].sort(hostProjectOrder).map((project) => (
          <DropdownMenuItem key={project.id} onClick={() => onStartOnHost(descriptor, project.path)}>
            <Icon name="folder" className="h-4 w-4" />
            <span dir="auto" className="min-w-0 truncate">{project.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

export const NewSessionMenuContent: React.FC<{
  onStartOnHost: (host: HostDescriptor, directory?: string) => void;
  /** Runs once a draft is open, e.g. to close the phone's drawer over it. */
  onStarted?: () => void;
}> = ({ onStartOnHost, onStarted }) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const { availability, hosts } = useMonitoredHosts();
  const otherHosts = availability === 'ready' || availability === 'error' ? hosts : [];
  return (
    <DropdownMenuContent align="start" className="max-h-[min(24rem,70vh)] min-w-[220px] max-w-[18rem] overflow-y-auto">
      {projects.length > 0 ? <>
        <DropdownMenuLabel>{t('sessions.newSession.menu.projects')}</DropdownMenuLabel>
        {projects.map((project) => {
          const label = project.label?.trim() || formatDirectoryName(project.path, null) || project.path;
          const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : undefined;
          const color = resolveProjectColor(project.color);
          return (
            <DropdownMenuItem
              key={project.id}
              onClick={() => {
                openNewSessionDraftAt(project.id, project.path);
                onStarted?.();
              }}
            >
              <Icon name={iconName ?? 'folder'} className="h-4 w-4" style={color ? { color } : undefined} />
              <span dir="auto" className="min-w-0 truncate">{label}</span>
            </DropdownMenuItem>
          );
        })}
      </> : null}
      {otherHosts.length > 0 ? <>
        {projects.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuLabel>{t('sessions.newSession.menu.hosts')}</DropdownMenuLabel>
        {otherHosts.map((host) => <HostMenuEntry key={host.descriptor.id} host={host} onStartOnHost={onStartOnHost} />)}
      </> : null}
      {projects.length > 0 || otherHosts.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onClick={() => sessionEvents.requestDirectoryDialog()}>
        <Icon name="folder-add" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.actions.addProject')}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
};

/**
 * The New session split button of the titlebar, and of the phone's drawer: the
 * main part opens a draft where the user is, the chevron picks where to start.
 * Labelled while the sidebar is open; an icon with a tooltip otherwise.
 */
export const NewSessionSplitButton: React.FC<{
  labelled: boolean;
  onStarted?: () => void;
}> = ({ labelled, onStarted }) => {
  const { t } = useI18n();
  // The menu's other hosts switch the window there and open a draft; the
  // dialog asks first when the composer holds an unsent message.
  const hostSession = useHostSessionActions();
  const handleNewSession = () => {
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().openNewSessionDraft();
    preselectRememberedDraftHost();
    onStarted?.();
  };
  const handleStartOnHost = (host: HostDescriptor, directory?: string) => {
    hostSession.actions.startDraftOn(host, directory);
    onStarted?.();
  };
  return (
    <div className="-ms-1 flex min-w-0 items-center">
      {labelled ? (
        <button
          type="button"
          onClick={handleNewSession}
          className={cn(ICON_BUTTON_CLASS, 'w-auto min-w-0 px-1.5 font-normal')}
        >
          <Icon name="chat-new" className="h-4 w-4 shrink-0" />
          <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
        </button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleNewSession}
              aria-label={t('sessions.sidebar.header.actions.newSession')}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
            >
              <Icon name="chat-new" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('sessions.sidebar.header.actions.newSession')}</p>
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('sessions.newSession.chooseProject')}
                className={cn(ICON_BUTTON_CLASS, 'w-4 shrink-0 data-[popup-open]:text-foreground')}
              >
                <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('sessions.newSession.chooseProject')}</p>
          </TooltipContent>
        </Tooltip>
        <NewSessionMenuContent onStartOnHost={handleStartOnHost} onStarted={onStarted} />
      </DropdownMenu>
    </div>
  );
};
