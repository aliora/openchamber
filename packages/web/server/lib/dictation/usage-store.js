import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const usageFileSchema = z.object({
  version: z.literal(1),
  months: z.record(z.string(), z.object({ elevenlabs: z.number().nonnegative().optional() })),
});

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/**
 * @param {{ filePath: string, now?: () => Date }} options
 */
export function createDictationUsageStore({ filePath, now = () => new Date() }) {
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[dictation] usage file is unreadable:', error?.message ?? error);
      }
      return { version: 1, months: {} };
    }
    try {
      return usageFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.warn('[dictation] usage file is malformed:', error?.message ?? error);
      return { version: 1, months: {} };
    }
  };

  const write = (usage) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(usage, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  };

  /**
   * @param {'elevenlabs'} provider
   * @param {number} seconds
   */
  const addCloudSeconds = (provider, seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    const usage = read();
    const month = monthKey(now());
    const current = usage.months[month] ?? {};
    usage.months[month] = { ...current, [provider]: (current[provider] ?? 0) + seconds };
    try {
      write(usage);
    } catch (error) {
      console.warn('[dictation] could not record usage:', error?.message ?? error);
    }
  };

  const readCurrentMonth = () => {
    const month = monthKey(now());
    return { month, elevenlabsSeconds: read().months[month]?.elevenlabs ?? 0 };
  };

  return { addCloudSeconds, readCurrentMonth };
}
