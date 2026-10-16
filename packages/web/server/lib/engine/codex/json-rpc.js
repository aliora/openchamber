import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { z } from 'zod';

// JSON-RPC 2.0 the way `codex app-server` speaks it over stdio: one JSON
// message per line, with the "jsonrpc" field left out. Emits `request` for a
// server-to-client request and `notification` for everything the server
// announces; responses settle the promise `request()` returned.

const requestIdSchema = z.union([z.string(), z.number().int()]);
const serverRequestSchema = z.object({ id: requestIdSchema, method: z.string(), params: z.unknown() });
const errorResponseSchema = z.object({
  id: requestIdSchema,
  error: z.object({ code: z.number().int(), message: z.string() }),
});
const resultResponseSchema = z.object({ id: requestIdSchema, result: z.unknown() });
const notificationSchema = z.object({ method: z.string(), params: z.unknown() });

export class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

export class JsonRpcConnection extends EventEmitter {
  constructor(input, output) {
    super();
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.closedWith = null;
    this.lines = readline.createInterface({ input, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.receive(line));
  }

  receive(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // stdout carries only protocol messages; a stray line is not one.
      return;
    }

    const request = serverRequestSchema.safeParse(message);
    if (request.success) {
      this.emit('request', request.data);
      return;
    }
    const failure = errorResponseSchema.safeParse(message);
    if (failure.success) {
      this.settle(failure.data.id, (entry) => entry.reject(new JsonRpcError(failure.data.error.code, failure.data.error.message)));
      return;
    }
    const response = resultResponseSchema.safeParse(message);
    if (response.success) {
      this.settle(response.data.id, (entry) => entry.resolve(response.data.result));
      return;
    }
    const notification = notificationSchema.safeParse(message);
    if (notification.success) {
      this.emit('notification', notification.data);
    }
  }

  settle(id, action) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    action(entry);
  }

  write(message) {
    if (this.closedWith) throw this.closedWith;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a request and resolves with its result, or rejects with a JsonRpcError. */
  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method) {
    this.write({ method });
  }

  respond(id, result) {
    if (this.closedWith) return;
    this.write({ id, result });
  }

  respondError(id, code, message) {
    if (this.closedWith) return;
    this.write({ id, error: { code, message } });
  }

  /** Rejects every unanswered request; later writes throw `error`. */
  close(error) {
    if (this.closedWith) return;
    this.closedWith = error;
    this.lines.close();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}
