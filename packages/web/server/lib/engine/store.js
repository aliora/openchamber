import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Stored paths use forward slashes so a Windows cwd matches its UI directory key.
const normalizeFsPath = (rawPath) => rawPath.replace(/\\/g, '/');

export class LocalSessionStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(os.homedir(), '.openchamber', 'data', 'sessions.json');
    this.data = null;
    this.ensureInitialized();
  }

  ensureInitialized() {
    if (this.data) return;

    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.data = { sessions: {}, messages: {} };
        this.saveSync();
      }
    } catch {
      this.data = { sessions: {}, messages: {} };
    }
  }

  saveSync() {
    if (!this.data) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.storagePath);
    } catch (err) {
      console.error('Failed to save session store:', err);
    }
  }

  async listSessions(options = {}) {
    this.ensureInitialized();
    const targetCwd = options.cwd ? normalizeFsPath(options.cwd).toLowerCase() : null;

    const list = Object.values(this.data.sessions || {});
    const filtered = targetCwd
      ? list.filter((s) => s.cwd && normalizeFsPath(s.cwd).toLowerCase() === targetCwd)
      : list;

    return filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async getSession(id) {
    this.ensureInitialized();
    return this.data.sessions?.[id] || null;
  }

  async createSession(data = {}) {
    this.ensureInitialized();
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
    this.ensureInitialized();
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
    this.ensureInitialized();
    if (!this.data.sessions?.[id]) return false;

    delete this.data.sessions[id];
    delete this.data.messages?.[id];
    this.saveSync();
    return true;
  }

  async getMessages(sessionId) {
    this.ensureInitialized();
    return this.data.messages?.[sessionId] || [];
  }

  async appendMessage(sessionId, message) {
    this.ensureInitialized();
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

    this.data.messages[sessionId].push(msg);

    if (this.data.sessions?.[sessionId]) {
      this.data.sessions[sessionId].updatedAt = Date.now();
    }

    this.saveSync();
    return msg;
  }

  async appendPart(sessionId, messageId, part) {
    this.ensureInitialized();
    const messages = this.data.messages?.[sessionId];
    if (!messages) return;

    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;

    if (!msg.parts) msg.parts = [];
    msg.parts.push(part);

    this.saveSync();
  }

  async updatePart(sessionId, messageId, partIndex, patch) {
    this.ensureInitialized();
    const messages = this.data.messages?.[sessionId];
    if (!messages) return;

    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.parts || !msg.parts[partIndex]) return;

    Object.assign(msg.parts[partIndex], patch);
    this.saveSync();
  }
}
