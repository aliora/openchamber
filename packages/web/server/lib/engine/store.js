import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Stored paths use forward slashes so a Windows cwd matches its UI directory key.
const normalizeFsPath = (rawPath) => rawPath.replace(/\\/g, '/');

// Several OpenChamber servers on one machine (the desktop app and `openchamber
// serve`, say) share this file. Each one re-reads it before every read and
// write when it changed on disk, so one server's save does not drop the
// sessions another one added. The writes are synchronous, so the window in
// which two servers could still interleave is a stat, a parse and a rename.
export class LocalSessionStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(os.homedir(), '.openchamber', 'data', 'sessions.json');
    this.data = null;
    this.loadedStamp = null;
    this.refresh();
  }

  // Every save renames a new file into place, so the inode changes even when
  // two saves land in the same millisecond with the same size.
  stampOf(stat) {
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  }

  /** Loads the file when this process has not seen its current version. */
  refresh() {
    let stat;
    try {
      stat = fs.statSync(this.storagePath);
    } catch {
      // No file yet: start empty and create it, so the next server reads the same thing.
      if (!this.data) {
        this.data = { sessions: {}, messages: {} };
        this.saveSync();
      }
      return;
    }
    if (this.data && this.loadedStamp === this.stampOf(stat)) return;

    try {
      this.data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      this.loadedStamp = this.stampOf(stat);
    } catch (err) {
      // An unreadable file is moved aside, never overwritten: an empty store
      // saved over it would erase every session it holds.
      const aside = `${this.storagePath}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(this.storagePath, aside);
        console.error(`[engine] Session store could not be read and was moved to ${aside}:`, err.message);
      } catch (renameErr) {
        console.error('[engine] Session store could not be read or moved aside:', renameErr.message);
      }
      if (!this.data) this.data = { sessions: {}, messages: {} };
      this.loadedStamp = null;
    }
  }

  saveSync() {
    if (!this.data) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      // The pid keeps two servers that save in the same millisecond off each other's temp file.
      const tmp = `${this.storagePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.storagePath);
      this.loadedStamp = this.stampOf(fs.statSync(this.storagePath));
    } catch (err) {
      console.error('Failed to save session store:', err);
    }
  }

  async listSessions(options = {}) {
    this.refresh();
    const targetCwd = options.cwd ? normalizeFsPath(options.cwd).toLowerCase() : null;

    const list = Object.values(this.data.sessions || {});
    const filtered = targetCwd
      ? list.filter((s) => s.cwd && normalizeFsPath(s.cwd).toLowerCase() === targetCwd)
      : list;

    return filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async getSession(id) {
    this.refresh();
    return this.data.sessions?.[id] || null;
  }

  async createSession(data = {}) {
    this.refresh();
    const id = data.id || crypto.randomUUID();
    const now = Date.now();

    const session = {
      id,
      engine: data.engine,
      title: data.title || 'Yeni Sohbet',
      cwd: data.cwd ? normalizeFsPath(data.cwd) : normalizeFsPath(process.cwd()),
      model: data.model || 'sonnet',
      effort: data.effort || 'medium',
      permissionMode: data.permissionMode || 'auto',
      createdAt: now,
      updatedAt: now,
    };

    if (!this.data.sessions) this.data.sessions = {};
    if (!this.data.messages) this.data.messages = {};

    this.data.sessions[id] = session;
    this.data.messages[id] = [];
    this.saveSync();

    return session;
  }

  async updateSession(id, patch = {}) {
    this.refresh();
    const session = this.data.sessions?.[id];
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    Object.assign(session, patch, { updatedAt: Date.now() });
    if (patch.cwd) {
      session.cwd = normalizeFsPath(patch.cwd);
    }

    this.saveSync();
    return session;
  }

  async deleteSession(id) {
    this.refresh();
    if (!this.data.sessions?.[id]) return false;

    delete this.data.sessions[id];
    delete this.data.messages?.[id];
    this.saveSync();
    return true;
  }

  async getMessages(sessionId) {
    this.refresh();
    return this.data.messages?.[sessionId] || [];
  }

  async appendMessage(sessionId, message) {
    this.refresh();
    if (!this.data.messages[sessionId]) {
      this.data.messages[sessionId] = [];
    }

    const msg = {
      id: message.id || crypto.randomUUID(),
      role: message.role || 'user',
      content: message.content || '',
      createdAt: message.createdAt || Date.now(),
      parts: message.parts || [],
    };
    if (message.agent) msg.agent = message.agent;
    if (message.model) msg.model = message.model;
    // An assistant message also keeps how its turn ended (wire-messages.js).
    if (message.completedAt) msg.completedAt = message.completedAt;
    if (message.outcome) msg.outcome = message.outcome;
    if (message.tokens) msg.tokens = message.tokens;

    this.data.messages[sessionId].push(msg);

    if (this.data.sessions?.[sessionId]) {
      this.data.sessions[sessionId].updatedAt = Date.now();
    }

    this.saveSync();
    return msg;
  }

  async appendPart(sessionId, messageId, part) {
    this.refresh();
    const messages = this.data.messages?.[sessionId];
    if (!messages) return;

    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;

    if (!msg.parts) msg.parts = [];
    msg.parts.push(part);

    this.saveSync();
  }

  async updatePart(sessionId, messageId, partIndex, patch) {
    this.refresh();
    const messages = this.data.messages?.[sessionId];
    if (!messages) return;

    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.parts || !msg.parts[partIndex]) return;

    Object.assign(msg.parts[partIndex], patch);
    this.saveSync();
  }
}
