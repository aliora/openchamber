import { OpenCodeProcess } from './opencode-process.js';
import { OpenCodeInstaller } from './installer.js';
import { createOpenCodeModelCatalog } from './model-catalog.js';
import { OpenCodeService, stopOpenCodeServices } from './service.js';

export const createOpenCodeEngine = ({ installer, readModels, createService, getEnvironment = () => process.env } = {}) => {
  const installation = installer ?? new OpenCodeInstaller({ getEnvironment });
  const serviceFactory = createService ?? ((options) => new OpenCodeService({ ...options, getEnvironment }));
  const catalog = createOpenCodeModelCatalog({ read: readModels, createService: serviceFactory });
  return {
    id: 'opencode', displayName: 'OpenCode', providerID: 'opencode', dynamicCatalog: true,
    modelCatalog: catalog.current,
    ensureModelCatalog: async (directory) => {
      await installation.refresh?.();
      if (!installation.getStatus().installed) throw new Error('OpenCode CLI is unavailable or incompatible.');
      await catalog.ensure(directory);
    },
    shutdown: stopOpenCodeServices,
    permissionModes: ['manual', 'bypass'], defaultPermissionMode: 'manual', permissionModeTiers: { manual: 'ask', bypass: 'full' }, dangerousPermissionModes: ['bypass'],
    installer: installation,
    auth: {
      status: async () => ({ loggedIn: catalog.hasModels(), email: null }),
      loginCommand: 'opencode auth login',
      login: () => { throw new Error('Sign in through a terminal: opencode auth login'); },
      logout: () => { throw new Error('Manage provider credentials in a terminal: opencode auth logout'); },
    },
    createProcess: (options) => new OpenCodeProcess({ ...options, createService: serviceFactory, invalidateCatalog: () => catalog.invalidate(options.cwd) }),
  };
};
