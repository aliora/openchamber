import { EventEmitter } from 'node:events';
import { OpenCodeService } from './service.js';
import { decodeModel } from './model-catalog.js';
import { createOpenCodeEventTranslator } from './event-translator.js';

export class OpenCodeProcess extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.service = (options.createService ?? ((input) => new OpenCodeService(input)))(options);
    this.isAlive = false;
    this.queue = [];
    this.active = false;
    this.requests = new Map();
    this.forms = new Map();
    this.controller = new AbortController();
    this.idleMs = options.idleMs ?? 60000;
    this.service.on('exit', () => { if (this.isAlive) { this.active = false; this.isAlive = false; this.emit('exit'); void this.abort(); } });
  }

  async start() {
    this.client = await this.service.start();
    this.isAlive = true;
    let connected;
    const ready = new Promise((resolve) => { connected = resolve; });
    const timer = setTimeout(() => connected(false), 15000);
    this.listening = this.listen(connected);
    if (!await ready) {
      clearTimeout(timer); await this.abort(); throw new Error('OpenCode event stream did not connect.');
    }
    clearTimeout(timer);
    try {
      const savedId = this.options.engineState?.sessionId;
      const upstream = savedId
        ? await this.client.session.get({ sessionID: savedId }, { signal: AbortSignal.timeout(15000) })
        : await this.client.session.create({ location: { directory: this.options.cwd }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] }, { signal: AbortSignal.timeout(15000) });
      this.upstreamId = upstream.id;
      this.translate = createOpenCodeEventTranslator(upstream.id, (name, data) => this.forward(name, data));
      const model = decodeModel(this.options.model);
      if (this.options.effort) model.variant = this.options.effort;
      await this.client.session.switchModel({ sessionID: upstream.id, model }, { signal: AbortSignal.timeout(15000) });
      this.emit('engine.state', { sessionId: upstream.id });
      this.armIdle();
    } catch (error) {
      await this.abort();
      if (this.options.engineState?.sessionId) throw new Error('OpenCode could not resume its saved conversation. Restore its data or start a new session.');
      throw error;
    }
  }

  async listen(connected) {
    try {
      for await (const event of this.client.event.subscribe({ signal: this.controller.signal, onActivity: () => this.touchStream() })) {
        this.touchStream();
        if (event.type === 'server.connected') {
          if (this.connected && this.active) { this.fail('OpenCode event stream reconnected during the turn. Partial output was preserved.'); break; }
          this.connected = true;
          connected(true);
        }
        if (['model.updated', 'provider.updated'].includes(event.type) && event.location?.directory?.replace(/\\/g, '/') === this.options.cwd.replace(/\\/g, '/')) {
          this.options.invalidateCatalog?.();
          this.emit('catalog.updated', { kind: event.type.split('.')[0] });
        }
        this.translate?.(event);
      }
      if (!this.controller.signal.aborted && this.isAlive) this.fail('OpenCode event stream ended.');
    } catch {
      if (!this.controller.signal.aborted && this.isAlive) this.fail('OpenCode event stream failed.');
    }
  }

  touchStream() {
    clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      if (this.isAlive && this.active) this.fail('OpenCode event stream stopped responding. Partial output was preserved.');
    }, this.options.streamTimeoutMs ?? 30000);
  }

  fail(message) {
    this.emit('error', new Error(message));
    void this.abort();
  }

  forward(name, data) {
    if (name === 'permission.requested') {
      clearTimeout(this.idleTimer);
      const requestId = `${this.options.sessionId}:${data.requestId}`;
      this.requests.set(requestId, data.requestId);
      this.emit(name, { ...data, requestId });
    } else if (name === 'form.requested') {
      clearTimeout(this.idleTimer);
      const id = `${this.options.sessionId}:${data.id}`;
      this.forms.set(id, data.id);
      this.emit(name, { ...data, id, sessionID: this.options.sessionId });
    } else if (name === 'form.settled') {
      const id = `${this.options.sessionId}:${data.id}`;
      this.forms.delete(id);
      this.emit(name, { ...data, id });
      this.armIdle();
    } else {
      if (name === 'turn.completed') this.active = false;
      this.emit(name, data);
      if (name === 'turn.completed') { this.next(); this.armIdle(); }
    }
  }

  sendUserMessage(text) {
    clearTimeout(this.idleTimer);
    this.queue.push(text);
    this.next();
  }

  next() {
    if (this.active || !this.isAlive || this.queue.length === 0) return;
    this.active = true;
    this.touchStream();
    const text = this.queue.shift();
    void this.client.session.prompt({ sessionID: this.upstreamId, text }, { signal: this.controller.signal })
      .catch(() => { if (this.isAlive) this.fail('OpenCode did not accept the prompt.'); });
  }

  respondPermission(requestId, decision) {
    const id = this.requests.get(requestId);
    if (!id) return;
    this.requests.delete(requestId);
    void this.client.permission.reply({ sessionID: this.upstreamId, requestID: id, decision: decision === 'allow' ? 'once' : 'reject' }, { signal: this.controller.signal })
      .catch(() => { if (this.isAlive) this.fail('OpenCode permission reply failed.'); });
  }

  async respondForm(id, answer) {
    const formID = this.forms.get(id);
    if (!formID) throw new Error('Pending OpenCode form not found.');
    const input = { sessionID: this.upstreamId, formID };
    if (answer === null) await this.client.session.form.cancel(input);
    else await this.client.session.form.reply({ ...input, answer });
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.active || this.queue.length || this.requests.size || this.forms.size) return;
    this.idleTimer = setTimeout(() => {
      if (!this.active && !this.queue.length && !this.requests.size && !this.forms.size) void this.abort().then(() => this.emit('exit'));
    }, this.idleMs);
  }

  async abort() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.isAlive = false;
      clearTimeout(this.idleTimer);
      clearTimeout(this.streamTimer);
      if (this.active && this.upstreamId) {
        await this.client.session.interrupt({ sessionID: this.upstreamId }, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
      this.controller.abort();
      await this.service.stop();
      await this.listening;
      this.queue.length = 0;
      this.requests.clear(); this.forms.clear();
    })();
    return this.stopping;
  }
}
