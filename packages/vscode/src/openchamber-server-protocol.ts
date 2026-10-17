import { z } from 'zod';

/**
 * The IPC messages between the extension host and the bundled server
 * (`openchamber-server-entry.ts`).
 *
 * The server reports once, when startup settled.
 */
export const serverStartupEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), port: z.number().int().min(1).max(65535) }),
  z.object({ type: z.literal('failed'), message: z.string() }),
]);

export type ServerStartupEvent = z.infer<typeof serverStartupEventSchema>;

/**
 * The extension host asks the server to shut down with a message rather than
 * by closing the channel: in Node a child process whose parent closed the
 * channel exits without its `close` event ever firing.
 */
export const serverCommandSchema = z.object({ type: z.literal('stop') });

export type ServerCommand = z.infer<typeof serverCommandSchema>;
