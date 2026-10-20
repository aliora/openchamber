export const PERMISSION_TIERS = ['read', 'ask', 'edits', 'auto', 'full'];

export const permissionTier = (adapter, mode) => PERMISSION_TIERS.indexOf(adapter.permissionModeTiers[mode]);

const mostPermissiveWithin = (adapter, tier) => {
  let chosen = null;
  for (const mode of adapter.permissionModes) {
    const modeTier = permissionTier(adapter, mode);
    if (modeTier <= tier && (chosen === null || modeTier > permissionTier(adapter, chosen))) chosen = mode;
  }
  return chosen;
};

const leastPermissive = (adapter) => adapter.permissionModes.reduce(
  (lowest, mode) => (permissionTier(adapter, mode) < permissionTier(adapter, lowest) ? mode : lowest),
);

export const inheritPermissionMode = (mode, source, target) => {
  if (source.id === target.id && target.permissionModes.includes(mode)) return mode;
  return mostPermissiveWithin(target, permissionTier(source, mode)) ?? leastPermissive(target);
};
