import { create } from 'zustand';

/**
 * The session the Move to host dialog is open for. `sourceHostId` is null for
 * a session of the focused host and the saved host's id otherwise.
 */
type SessionTransferTarget = {
  sessionId: string;
  title: string;
  sourceHostId: string | null;
};

type SessionTransferState = {
  target: SessionTransferTarget | null;
  open: (target: SessionTransferTarget) => void;
  close: () => void;
};

export const useSessionTransferStore = create<SessionTransferState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openSessionTransfer = (target: SessionTransferTarget): void => {
  useSessionTransferStore.getState().open(target);
};
