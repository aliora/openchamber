import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDictationUsageStore } from './usage-store.js';

describe('dictation usage store', () => {
  let dir;
  let filePath;
  let now;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dictation-usage-'));
    filePath = path.join(dir, 'dictation-usage.json');
    now = new Date(2026, 9, 19, 12);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createStore = () => createDictationUsageStore({ filePath, now: () => now });

  it('answers zero for a month without dictation', () => {
    expect(createStore().readCurrentMonth()).toEqual({ month: '2026-10', elevenlabsSeconds: 0 });
  });

  it('adds cloud seconds to the current month and keeps them across restarts', () => {
    createStore().addCloudSeconds('elevenlabs', 15.5);
    createStore().addCloudSeconds('elevenlabs', 4.5);
    expect(createStore().readCurrentMonth()).toEqual({ month: '2026-10', elevenlabsSeconds: 20 });
  });

  it('starts a new count when the month changes', () => {
    const store = createStore();
    store.addCloudSeconds('elevenlabs', 30);
    now = new Date(2026, 10, 1, 9);
    expect(store.readCurrentMonth()).toEqual({ month: '2026-11', elevenlabsSeconds: 0 });
    store.addCloudSeconds('elevenlabs', 10);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(stored.months).toEqual({ '2026-10': { elevenlabs: 30 }, '2026-11': { elevenlabs: 10 } });
  });

  it('treats a malformed file as empty and replaces it on the next write', () => {
    fs.writeFileSync(filePath, '{not json');
    const store = createStore();
    expect(store.readCurrentMonth().elevenlabsSeconds).toBe(0);
    store.addCloudSeconds('elevenlabs', 5);
    expect(store.readCurrentMonth().elevenlabsSeconds).toBe(5);
  });
});
