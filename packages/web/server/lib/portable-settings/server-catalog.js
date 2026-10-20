import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listMcpConfigs, createMcpConfig, deleteMcpConfig } from '../opencode/mcp.js';
import { listUserAgentFiles, getAgentConfig, writeUserAgent, deleteAgent } from '../opencode/agents.js';
import { listUserCommandFiles, getCommandConfig, writeUserCommand, deleteCommand } from '../opencode/commands.js';
import { discoverSkills } from '../opencode/skills.js';
import { OPENCODE_CONFIG_DIR, SKILL_DIR } from '../opencode/shared.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createPortableSettingsCatalog } from './catalog.js';
import {
  createAgentsCategory,
  createCommandsCategory,
  createGitIdentitiesCategory,
  createMcpCategory,
  createProjectsCategory,
  createScheduledTasksCategory,
  createSkillsCategory,
} from './categories.js';

const pathExists = async (target) => {
  try {
    await fs.promises.stat(target);
    return true;
  } catch {
    return false;
  }
};

const userSkillRoots = () => {
  const home = os.homedir();
  return [
    SKILL_DIR,
    path.join(OPENCODE_CONFIG_DIR, 'skill'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
  ];
};

export const createServerPortableSettingsCatalog = async ({
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  persistSettings,
  projectConfigRuntime,
  scheduledTaskService,
}) => {
  const git = await import('../git/index.js');
  return createPortableSettingsCatalog({
    pathExists,
    categories: {
      mcp: createMcpCategory({ listMcpConfigs, createMcpConfig, deleteMcpConfig }),
      agents: createAgentsCategory({ listUserAgentFiles, getAgentConfig, writeUserAgent, deleteAgent }),
      commands: createCommandsCategory({ listUserCommandFiles, getCommandConfig, writeUserCommand, deleteCommand }),
      skills: createSkillsCategory({ discoverSkills, userSkillRoots: userSkillRoots() }),
      gitIdentities: createGitIdentitiesCategory({
        getProfiles: git.getProfiles,
        createProfile: git.createProfile,
        updateProfile: git.updateProfile,
        deleteProfile: git.deleteProfile,
        toPublicGitIdentityProfile: git.toPublicGitIdentityProfile,
      }),
      projects: createProjectsCategory({ readSettingsFromDiskMigrated, sanitizeProjects, persistSettings, createProjectIdFromPath }),
      scheduledTasks: createScheduledTasksCategory({ readSettingsFromDiskMigrated, sanitizeProjects, projectConfigRuntime, scheduledTaskService }),
    },
  });
};
