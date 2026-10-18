import React from 'react';

import { toast } from '@/components/ui';
import type { PairingConnectionPayload } from '@/lib/connectionPayload';

import { useDeepLinkPairingHandler } from './deepLinkNavigation';
import { useMobileConnection } from './mobileConnections';
import { requestEngineSetupCheck } from './mobileEngineSetupCheck';
import { MobileQrConnectionLoading } from './MobileQrScannerOverlay';

export const MobilePairingDeepLinkListener: React.FC = () => {
  const { redeemPairingConnection, isBusy, error, setError } = useMobileConnection(requestEngineSetupCheck);
  const handlePairingDeepLink = React.useCallback((pairing: PairingConnectionPayload) => {
    void redeemPairingConnection(pairing);
  }, [redeemPairingConnection]);
  useDeepLinkPairingHandler(handlePairingDeepLink);

  React.useEffect(() => {
    if (!error) return;
    toast.error(error);
    setError(null);
  }, [error, setError]);

  return isBusy ? <MobileQrConnectionLoading /> : null;
};
