import { getRuntimeKey } from '@/lib/runtime-switch';
import { getAmbientHost } from './ambient-host';

export const currentHostKey = (): string => getAmbientHost()?.id ?? getRuntimeKey();
