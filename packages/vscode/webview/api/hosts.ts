import type { HostsAPI } from '@openchamber/ui/lib/api/types';

// The extension keeps no list of other OpenChamber hosts, so the webview
// monitors none.
export const createVSCodeHostsAPI = (): HostsAPI => ({
  listHosts: async () => ({ status: 'unsupported' }),
  getCredential: async () => null,
});
