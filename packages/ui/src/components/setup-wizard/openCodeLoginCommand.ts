export const openCodeLoginCommand = (binary: string | null, shell: string): string => {
  if (!binary) return 'opencode auth login';
  const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
  if (/^[A-Za-z]:[\\/]/.test(binary)) {
    if (shell === 'cmd') return `"${binary}" auth login`;
    return `& '${binary.replaceAll("'", "''")}' auth login`;
  }
  return `env ${quoted} auth login`;
};
