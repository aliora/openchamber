import os from 'node:os';
import path from 'node:path';

export const resolveEngineDataDir = ({ env = process.env, home = os.homedir() } = {}) => {
  const defaultDir = path.join(home, '.openchamber', 'data');
  if (!env.OPENCHAMBER_DATA_DIR) return defaultDir;
  const dataDir = path.resolve(env.OPENCHAMBER_DATA_DIR);
  if (dataDir === path.join(home, '.config', 'openchamber')) return defaultDir;
  return path.join(dataDir, 'engine');
};
