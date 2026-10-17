import React from 'react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { PROJECT_ICON_MAP, resolveProjectColor } from '@/lib/projectMeta';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import type { HostDescriptor } from '@/lib/hosts/types';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';

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
export const NewSessionMenuContent: React.FC<{ onStartOnHost: (host: HostDescriptor) => void }> = ({ onStartOnHost }) => {
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
              onClick={() => openNewSessionDraftAt(project.id, project.path)}
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
        {otherHosts.map(({ descriptor }) => (
          <DropdownMenuItem key={descriptor.id} onClick={() => onStartOnHost(descriptor)}>
            <Icon name={descriptor.kind === 'local' ? 'computer' : 'server'} className="h-4 w-4" />
            <span dir="auto" className="min-w-0 truncate">{formatHostLabel(descriptor, t)}</span>
          </DropdownMenuItem>
        ))}
      </> : null}
      {projects.length > 0 || otherHosts.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onClick={() => sessionEvents.requestDirectoryDialog()}>
        <Icon name="folder-add" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.actions.addProject')}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
};
