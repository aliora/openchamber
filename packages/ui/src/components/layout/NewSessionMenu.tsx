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
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { PROJECT_ICON_MAP, resolveProjectColor } from '@/lib/projectMeta';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Where a new session starts. Today that is a chat or one of this host's
 * projects; picking another OpenChamber host adds its own kind here (a host
 * level above the projects) without changing how a choice opens its draft.
 */
type NewSessionTarget =
  | { kind: 'chat' }
  | { kind: 'project'; projectId: string; directory: string };

const openNewSessionDraftAt = (target: NewSessionTarget): void => {
  // Starting a draft always leaves any full-page surface.
  useUIStore.getState().closeMainSurfaces();
  if (target.kind === 'chat') {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null });
    return;
  }
  useProjectsStore.getState().setActiveProjectIdOnly(target.projectId);
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: target.projectId, directoryOverride: target.directory });
};

/**
 * The menu of the titlebar's New session split button: a new chat, a
 * session in one of the projects, or adding a project first. The main part
 * of the button keeps opening a draft where the user is.
 */
export const NewSessionMenuContent: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  return (
    <DropdownMenuContent align="start" className="max-h-[min(24rem,70vh)] min-w-[220px] max-w-[18rem] overflow-y-auto">
      <DropdownMenuItem onClick={() => openNewSessionDraftAt({ kind: 'chat' })}>
        <Icon name="chat-4" className="h-4 w-4" />
        <span>{t('sessions.newSession.menu.chat')}</span>
      </DropdownMenuItem>
      {projects.length > 0 ? <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('sessions.newSession.menu.projects')}</DropdownMenuLabel>
        {projects.map((project) => {
          const label = project.label?.trim() || formatDirectoryName(project.path, null) || project.path;
          const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : undefined;
          const color = resolveProjectColor(project.color);
          return (
            <DropdownMenuItem
              key={project.id}
              onClick={() => openNewSessionDraftAt({ kind: 'project', projectId: project.id, directory: project.path })}
            >
              <Icon name={iconName ?? 'folder'} className="h-4 w-4" style={color ? { color } : undefined} />
              <span dir="auto" className="min-w-0 truncate">{label}</span>
            </DropdownMenuItem>
          );
        })}
      </> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => sessionEvents.requestDirectoryDialog()}>
        <Icon name="folder-add" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.actions.addProject')}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
};
