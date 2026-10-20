import type { HostId } from './types';

let readWindowHostId: () => HostId | null = () => null;

export const followWindowHost = (read: () => HostId | null): void => {
  readWindowHostId = read;
};

export const windowHostKey = (): HostId | null => readWindowHostId();
