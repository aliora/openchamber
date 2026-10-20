import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPlainObject, isString } from '../shared/guards.js';
import { expandPortablePath, toPortablePath } from './catalog.js';

const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const SCHEDULED_TASK_KEY_SEPARATOR = '@';

const isSafeRelativePath = (value) => isString(value)
  && value.length > 0
  && !value.includes('\\')
  && !value.includes('\0')
  && !value.startsWith('/')
  && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');

const isSafeName = (value) => isSafeRelativePath(value) && !value.includes('/');

const mtimeOf = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const withoutKeys = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const absoluteCommandPath = (entity) => {
  const command = Array.isArray(entity.command) ? entity.command[0] : null;
  return isString(command) && (command.startsWith('/') || command.startsWith('~/')) ? command : null;
};

export const createMcpCategory = ({ listMcpConfigs, createMcpConfig, deleteMcpConfig }) => ({
  async list() {
    return listMcpConfigs(null)
      .filter((entry) => entry.scope !== 'project')
      .map((entry) => {
        const value = withoutKeys(entry, ['name', 'scope', 'sectionKey', 'legacy']);
        const commandPath = absoluteCommandPath(value);
        return {
          key: entry.name,
          label: entry.name,
          detail: isString(value.type) ? value.type : undefined,
          value,
          updatedAt: null,
          paths: commandPath ? [commandPath] : [],
        };
      });
  },
  parse: (key, value) => (isSafeName(key) && isPlainObject(value) && isString(value.type) ? value : null),
  requiredPaths: (_key, value) => {
    const commandPath = absoluteCommandPath(value);
    return commandPath ? [commandPath] : [];
  },
  async write(key, value, current) {
    if (current) deleteMcpConfig(key, null);
    createMcpConfig(key, value, null, 'user');
  },
  async remove(key) {
    deleteMcpConfig(key, null);
  },
});

const createMarkdownEntityCategory = ({ listFiles, readEntity, writeEntity, deleteEntity, isValidKey }) => ({
  async list() {
    return listFiles().map(({ name, path: filePath }) => ({
      key: name,
      label: name,
      value: readEntity(name),
      updatedAt: mtimeOf(filePath),
      paths: [],
    }));
  },
  parse: (key, value) => (isValidKey(key) && isPlainObject(value) ? value : null),
  requiredPaths: () => [],
  async write(key, value) {
    writeEntity(key, value);
  },
  async remove(key) {
    deleteEntity(key);
  },
});

export const createAgentsCategory = ({ listUserAgentFiles, getAgentConfig, writeUserAgent, deleteAgent }) => createMarkdownEntityCategory({
  listFiles: listUserAgentFiles,
  readEntity: (name) => getAgentConfig(name, null).config,
  writeEntity: writeUserAgent,
  deleteEntity: (name) => deleteAgent(name, null, 'user'),
  isValidKey: isSafeName,
});

export const createCommandsCategory = ({ listUserCommandFiles, getCommandConfig, writeUserCommand, deleteCommand }) => createMarkdownEntityCategory({
  listFiles: listUserCommandFiles,
  readEntity: (name) => getCommandConfig(name, null).config,
  writeEntity: writeUserCommand,
  deleteEntity: (name) => deleteCommand(name, null),
  isValidKey: isSafeRelativePath,
});

const listSkillFiles = (dir) => {
  const files = [];
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length > MAX_SKILL_FILES) return;
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, `${relative}/`);
      else if (entry.isFile()) {
        const stats = fs.statSync(absolute);
        files.push({ relative, absolute, size: stats.size, mtime: stats.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return files;
};

const readSkill = (dir) => {
  const listed = listSkillFiles(dir);
  const updatedAt = listed.reduce((latest, file) => Math.max(latest, file.mtime), 0) || null;
  const bytes = listed.reduce((total, file) => total + file.size, 0);
  if (listed.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
    return { tooLarge: true, updatedAt, manifest: listed.map((file) => `${file.relative}:${file.size}`) };
  }
  const files = listed.map(({ relative, absolute }) => ({ path: relative, content: fs.readFileSync(absolute).toString('base64') }));
  return { tooLarge: false, updatedAt, files };
};

const parseSkillValue = (value) => {
  if (!isPlainObject(value) || !isString(value.root) || !isSafeRelativePath(value.dir) || !Array.isArray(value.files)) return null;
  if (value.files.length === 0 || value.files.length > MAX_SKILL_FILES) return null;
  const seen = new Set();
  for (const file of value.files) {
    if (!isPlainObject(file) || !isSafeRelativePath(file.path) || !isString(file.content) || seen.has(file.path)) return null;
    seen.add(file.path);
  }
  if (!seen.has('SKILL.md')) return null;
  return { root: value.root, dir: value.dir, files: value.files.map((file) => ({ path: file.path, content: file.content })) };
};

const replaceDirectory = (targetDir, files) => {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(targetDir)}.sync-`));
  const backup = `${staging}.previous`;
  try {
    for (const file of files) {
      const destination = path.join(staging, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.content, 'base64'));
    }
    const hadPrevious = fs.existsSync(targetDir);
    if (hadPrevious) fs.renameSync(targetDir, backup);
    try {
      fs.renameSync(staging, targetDir);
    } catch (error) {
      if (hadPrevious) fs.renameSync(backup, targetDir);
      throw error;
    }
    if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

export const createSkillsCategory = ({ discoverSkills, userSkillRoots, home = os.homedir() }) => {
  const rootOf = (skillDir) => userSkillRoots.find((root) => {
    const relative = path.relative(root, skillDir);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }) ?? null;

  const newSkillDir = (value) => path.join(expandPortablePath(value.root, home), ...value.dir.split('/'));

  return {
    async list() {
      const skills = (await discoverSkills(null)).filter((skill) => skill.scope === 'user' && isString(skill.path));
      return skills.flatMap((skill) => {
        const dir = path.dirname(skill.path);
        const root = rootOf(dir);
        if (!root) return [];
        const portableRoot = toPortablePath(root, home);
        const contents = readSkill(dir);
        const location = { root: portableRoot, dir: path.relative(root, dir).split(path.sep).join('/') };
        return [{
          key: skill.name,
          label: skill.name,
          detail: portableRoot,
          value: contents.tooLarge ? { ...location, manifest: contents.manifest } : { ...location, files: contents.files },
          updatedAt: contents.updatedAt,
          paths: [portableRoot],
          location: dir,
          tooLarge: contents.tooLarge,
        }];
      });
    },
    exportRefusal: (item) => (item.tooLarge ? 'too-large' : null),
    parse: (key, value) => {
      const parsed = parseSkillValue(value);
      return parsed && isString(key) && key.length > 0 ? parsed : null;
    },
    requiredPaths: (_key, value, current) => (current ? [] : [value.root]),
    writeRefusal: (_key, value, current) => {
      if (current) return fs.lstatSync(current.location).isSymbolicLink() ? 'linked' : null;
      return fs.existsSync(newSkillDir(value)) ? 'conflict' : null;
    },
    async write(_key, value, current) {
      replaceDirectory(current?.location ?? newSkillDir(value), value.files);
    },
    async remove(_key, current) {
      if (fs.lstatSync(current.location).isSymbolicLink()) throw new Error('Linked skill directories are not removed');
      fs.rmSync(current.location, { recursive: true, force: true });
    },
  };
};

const GIT_IDENTITY_FIELDS = ['name', 'userName', 'userEmail', 'signCommits', 'signingKey', 'color', 'icon'];

const portableIdentityOf = (profile) => ({
  name: profile.name,
  userName: profile.userName,
  userEmail: profile.userEmail,
  signCommits: profile.signCommits === true,
  signingKey: isString(profile.signingKey) && profile.signingKey ? profile.signingKey : null,
  color: isString(profile.color) && profile.color ? profile.color : null,
  icon: isString(profile.icon) && profile.icon ? profile.icon : null,
});

const signingKeyPath = (value) => (
  isString(value.signingKey) && (value.signingKey.startsWith('/') || value.signingKey.startsWith('~/')) ? value.signingKey : null
);

export const createGitIdentitiesCategory = ({ getProfiles, createProfile, updateProfile, deleteProfile, toPublicGitIdentityProfile }) => ({
  async list() {
    return getProfiles().map((stored) => {
      const profile = toPublicGitIdentityProfile(stored);
      const value = portableIdentityOf(profile);
      const keyPath = signingKeyPath(value);
      return {
        key: profile.id,
        label: profile.name,
        detail: profile.userEmail,
        value,
        updatedAt: null,
        paths: keyPath ? [keyPath] : [],
        profile,
      };
    });
  },
  parse: (key, value) => {
    if (!isString(key) || key.length > 200 || !isPlainObject(value)) return null;
    if (Object.keys(value).some((field) => !GIT_IDENTITY_FIELDS.includes(field))) return null;
    if (!isString(value.name) || !isString(value.userName) || !isString(value.userEmail)) return null;
    return portableIdentityOf(value);
  },
  requiredPaths: (_key, value) => {
    const keyPath = signingKeyPath(value);
    return keyPath ? [keyPath] : [];
  },
  async write(key, value, current) {
    if (!current) {
      createProfile({ id: key, ...value, account: null, transport: 'system' });
      return;
    }
    const { profile } = current;
    const next = { id: key, ...value, account: profile.account, transport: profile.transport };
    if (profile.sshCredentialId) next.sshCredentialId = profile.sshCredentialId;
    updateProfile(key, next);
  },
  async remove(key) {
    deleteProfile(key);
  },
});

const PROJECT_FIELDS = ['label', 'icon', 'iconBackground', 'color', 'defaultAgent', 'defaultModel', 'defaultVariant'];

const portableProjectOf = (project) => Object.fromEntries(
  PROJECT_FIELDS.filter((field) => isString(project[field]) && project[field]).map((field) => [field, project[field]]),
);

const createProjectsReader = ({ readSettingsFromDiskMigrated, sanitizeProjects, home }) => async () => {
  const settings = await readSettingsFromDiskMigrated();
  return (sanitizeProjects(settings?.projects || []) || []).map((project) => ({ project, portablePath: toPortablePath(project.path, home) }));
};

export const createProjectsCategory = ({ readSettingsFromDiskMigrated, sanitizeProjects, persistSettings, createProjectIdFromPath, home = os.homedir(), now = Date.now }) => {
  const readProjects = createProjectsReader({ readSettingsFromDiskMigrated, sanitizeProjects, home });
  const writeProjects = async (update) => {
    const projects = (await readProjects()).map(({ project }) => project);
    await persistSettings({ projects: update(projects) });
  };
  return {
    normalizeKey: (key) => (path.isAbsolute(key) ? toPortablePath(path.resolve(key), home) : key),
    async list() {
      return (await readProjects()).map(({ project, portablePath }) => ({
        key: portablePath,
        label: project.label || path.basename(project.path),
        detail: portablePath,
        value: portableProjectOf(project),
        updatedAt: null,
        paths: [portablePath],
        project,
      }));
    },
    parse: (key, value) => {
      if (!isString(key) || !(key.startsWith('~') || path.isAbsolute(key)) || !isPlainObject(value)) return null;
      if (Object.entries(value).some(([field, fieldValue]) => !PROJECT_FIELDS.includes(field) || !isString(fieldValue))) return null;
      return portableProjectOf(value);
    },
    requiredPaths: (key) => [key],
    async write(key, value, current) {
      if (current) {
        await writeProjects((projects) => projects.map((project) => (
          project.id === current.project.id ? { ...withoutKeys(project, PROJECT_FIELDS), ...value } : project
        )));
        return;
      }
      const absolutePath = expandPortablePath(key, home);
      await writeProjects((projects) => [...projects, { id: createProjectIdFromPath(absolutePath), path: absolutePath, ...value, addedAt: now() }]);
    },
    async remove(_key, current) {
      await writeProjects((projects) => projects.filter((project) => project.id !== current.project.id));
    },
  };
};

const SCHEDULED_TASK_STATE_FIELDS = ['state', 'loopFile', 'targetSessionId', 'id'];

const scheduledTaskKey = (taskId, portablePath) => `${taskId}${SCHEDULED_TASK_KEY_SEPARATOR}${portablePath}`;

const parseScheduledTaskKey = (key) => {
  const separator = key.indexOf(SCHEDULED_TASK_KEY_SEPARATOR);
  if (separator <= 0) return null;
  const taskId = key.slice(0, separator);
  const portablePath = key.slice(separator + 1);
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId) || !(portablePath.startsWith('~') || path.isAbsolute(portablePath))) return null;
  return { taskId, portablePath };
};

export const createScheduledTasksCategory = ({ readSettingsFromDiskMigrated, sanitizeProjects, projectConfigRuntime, scheduledTaskService, home = os.homedir() }) => {
  const readProjects = createProjectsReader({ readSettingsFromDiskMigrated, sanitizeProjects, home });
  const projectFor = async (key) => {
    const { portablePath } = parseScheduledTaskKey(key);
    return (await readProjects()).find((entry) => entry.portablePath === portablePath) ?? null;
  };
  return {
    normalizeKey: async (key) => {
      const separator = key.indexOf(SCHEDULED_TASK_KEY_SEPARATOR);
      if (separator <= 0) return key;
      const scope = key.slice(separator + 1);
      if (path.isAbsolute(scope)) return scheduledTaskKey(key.slice(0, separator), toPortablePath(path.resolve(scope), home));
      if (scope.startsWith('~')) return key;
      const project = (await readProjects()).find((entry) => entry.project.id === scope);
      return project ? scheduledTaskKey(key.slice(0, separator), project.portablePath) : key;
    },
    async list() {
      const projects = await readProjects();
      const perProject = await Promise.all(projects.map(async ({ project, portablePath }) => {
        const tasks = await projectConfigRuntime.listScheduledTasks(project.id);
        return tasks
          .filter((task) => isString(task?.id) && !task.loopFile && !task.targetSessionId)
          .map((task) => ({
            key: scheduledTaskKey(task.id, portablePath),
            label: task.name,
            detail: portablePath,
            value: withoutKeys(task, SCHEDULED_TASK_STATE_FIELDS),
            updatedAt: Number.isFinite(task.state?.updatedAt) ? task.state.updatedAt : null,
            paths: [portablePath],
            projectId: project.id,
            taskId: task.id,
          }));
      }));
      return perProject.flat();
    },
    parse: (key, value) => {
      if (!isString(key) || !parseScheduledTaskKey(key) || !isPlainObject(value) || !isString(value.name)) return null;
      return withoutKeys(value, SCHEDULED_TASK_STATE_FIELDS);
    },
    requiredPaths: (key) => [parseScheduledTaskKey(key).portablePath],
    writeRefusal: async (key) => ((await projectFor(key)) ? null : 'project-missing'),
    async write(key, value) {
      const project = await projectFor(key);
      if (!project) throw new Error('Project is not registered on this instance');
      await scheduledTaskService.upsert(project.project.id, { ...value, id: parseScheduledTaskKey(key).taskId });
    },
    async remove(_key, current) {
      await scheduledTaskService.remove(current.projectId, current.taskId);
    },
  };
};
