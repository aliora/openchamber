import type { IconName } from '@/components/icon/icons';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';

/** The icon and title of each zone, shared by the desktop's zone headers and the phone's. */
// The list by time holds every project's sessions, so it is titled Projects;
// its clock icon says how it is ordered.
export const ACTIVITY_ICON = {
  attention: 'notification-3',
  running: 'pulse',
  pinned: 'pushpin',
  work: 'eye',
  chats: 'chat-4',
  scheduled: 'calendar-schedule',
  timeline: 'history',
} as const satisfies Record<SessionSidebarActivityKey, IconName>;
export const ACTIVITY_TITLE_KEY = {
  attention: 'sessions.sidebar.activity.attentionTitle',
  running: 'sessions.sidebar.activity.runningTitle',
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  chats: 'sessions.sidebar.activity.chatsTitle',
  scheduled: 'sessions.sidebar.activity.scheduledTitle',
  timeline: 'sessions.sidebar.activity.projectsTitle',
} as const satisfies Record<SessionSidebarActivityKey, string>;
