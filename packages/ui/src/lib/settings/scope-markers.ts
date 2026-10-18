import type { SettingsPageSlug } from './metadata';
import { getSettingsScope, type SettingsKey, type SettingsScope } from './registry';

const PAGE_SCOPES: Partial<Record<SettingsPageSlug, SettingsScope>> = {
  appearance: 'profile',
  chat: 'profile',
  shortcuts: 'profile',
  notifications: 'profile',
  usage: 'profile',
  projects: 'instance',
  providers: 'instance',
  agents: 'instance',
  commands: 'instance',
  mcp: 'instance',
  plugins: 'instance',
  'skills.installed': 'instance',
  'skills.catalog': 'instance',
  git: 'instance',
  integrations: 'instance',
  extensions: 'instance',
  tunnel: 'instance',
  'isolated-spaces': 'instance',
};

const ITEM_KEYS: Readonly<Record<string, SettingsKey>> = {
  'appearance.pwa-install-name': 'pwaAppName',
  'appearance.pwa-orientation': 'pwaOrientation',
  'appearance.mobile-keyboard-mode': 'mobileKeyboardMode',
  'appearance.input-bar-offset': 'inputBarOffset',
  'sessions.desktop-window-controls-position': 'desktopWindowControlsPosition',
  'sessions.desktop-window-controls-style': 'desktopWindowControlsStyle',
  'appearance.terminal-shell': 'terminalShell',
  'appearance.auto-save-enabled': 'autoSaveEnabled',
  'appearance.confirm-file-tree-move': 'confirmFileTreeMove',
  'appearance.file-tree-side': 'fileTreeSide',
  'appearance.layout-animations': 'layoutAnimations',
  'appearance.open-links-in-browser-panel': 'openLinksInBrowserPanel',
  'appearance.open-tracker-links-on-board': 'openTrackerLinksOnBoard',
  'appearance.file-editor-keymap': 'fileEditorKeymap',
  'appearance.session-tabs': 'sessionTabsEnabled',
  'appearance.usage-reports': 'reportUsage',
  'chat.message-transport': 'messageStreamTransport',
  'chat.message-search-enabled': 'messageSearchEnabled',
  'chat.message-search-reasoning': 'messageSearchReasoningEnabled',
  'sessions.desktop-mac-menu-bar': 'desktopMacMenuBarEnabled',
  'sessions.desktop-linux-native-frame': 'desktopLinuxNativeFrame',
  'sessions.desktop-minimize-to-tray': 'desktopMinimizeToTrayEnabled',
  'sessions.desktop-keep-awake': 'desktopKeepAwakeEnabled',
  'sessions.desktop-ui-password': 'desktopUiPassword',
  'sessions.desktop-lan-access': 'desktopLanAccessEnabled',
  'sessions.agent-control-tool': 'agentControlToolEnabled',
  'sessions.agent-worktree-move': 'agentWorktreeMoveWithoutAsking',
  'sessions.agent-web-tool': 'agentWebToolEnabled',
  'sessions.browser-provider': 'browserProvider',
  'sessions.agent-notify-tool': 'agentNotifyToolEnabled',
  'sessions.agent-render-tool': 'agentRenderToolEnabled',
  'sessions.agent-knowledge-tool': 'agentKnowledgeToolEnabled',
  'sessions.agent-memory-tool': 'agentMemoryToolEnabled',
  'sessions.agent-tools-code-mode': 'agentToolsCodeMode',
  'sessions.default-model': 'defaultModel',
  'sessions.default-thinking': 'defaultVariant',
  'sessions.default-agent': 'defaultAgent',
  'sessions.deletion-dialog': 'showDeletionDialog',
  'sessions.small-model': 'smallModelOverride',
  'sessions.walkthrough-model': 'walkthroughModelOverride',
  'sessions.work-enabled': 'sessionWorkEnabled',
  'sessions.permission-default': 'permissionDefaultMode',
  'sessions.auto-cleanup': 'autoDeleteEnabled',
  'sessions.merged-worktree-cleanup': 'mergedWorktreeCleanupEnabled',
  'sessions.retention-only-archived': 'sessionRetentionOnlyArchived',
  'sessions.retention-period': 'autoDeleteAfterDays',
  'sessions.retention-action': 'sessionRetentionAction',
  'git.changes-view': 'gitChangesViewMode',
  'git.gitmoji': 'gitmojiEnabled',
  'git.gitignored-files': 'filesViewShowGitignored',
  'usage.work-status-panel': 'workStatusPanelEnabled',
};

const LOCAL_DEVICE_ITEMS: ReadonlySet<string> = new Set([
  'appearance.dock-badge',
  'appearance.scrollbars',
  'appearance.terminal-quick-keys',
]);

export const getSettingsPageScope = (slug: SettingsPageSlug): SettingsScope | null => PAGE_SCOPES[slug] ?? null;

export const getSettingsItemScope = (itemId: string): SettingsScope | null => {
  if (LOCAL_DEVICE_ITEMS.has(itemId)) return 'device';
  const key = ITEM_KEYS[itemId];
  return key ? getSettingsScope(key) : null;
};
