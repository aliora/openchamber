import { describe, it, expect, beforeEach } from 'bun:test';
import { createAutoResume, DEFAULT_RESUME_PROMPT, readAutoResume } from './auto-resume.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;
const LIMIT_ERROR = { message: 'Usage limit reached, try again in 2 hours' };

describe('auto-resume', () => {
  let sessions;
  let store;
  let timers;
  let scheduled;
  let announced;
  let resumed;
  let resumeBehavior;
  let autoResume;

  const stateOf = (id = 's1') => readAutoResume(sessions.get(id));
  const fireTimer = async () => {
    const [handle] = [...scheduled.keys()];
    const entry = scheduled.get(handle);
    scheduled.delete(handle);
    entry.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const seed = (id, autoResumeState, extraOpenchamber = {}) => {
    sessions.set(id, {
      id,
      engine: 'claude',
      metadata: { openchamber: { ...extraOpenchamber } },
    });
    if (autoResumeState) sessions.get(id).metadata.openchamber.autoResume = autoResumeState;
  };

  beforeEach(() => {
    sessions = new Map();
    scheduled = new Map();
    announced = [];
    resumed = [];
    resumeBehavior = async () => {};
    let nextHandle = 1;
    timers = {
      setTimeout: (callback, delay) => {
        const handle = nextHandle++;
        scheduled.set(handle, { callback, delay });
        return handle;
      },
      clearTimeout: (handle) => scheduled.delete(handle),
    };
    store = {
      getSession: async (id) => sessions.get(id) ?? null,
      updateSession: async (id, patch) => {
        const next = { ...sessions.get(id), ...patch };
        sessions.set(id, next);
        return next;
      },
      listSessions: async () => [...sessions.values()],
    };
    autoResume = createAutoResume({
      store,
      resumeSession: async (session, text) => {
        resumed.push({ sessionId: session.id, text });
        await resumeBehavior(session, text);
      },
      announce: (sessionId, metadata) => announced.push({ sessionId, metadata }),
      now: () => NOW,
      timers,
    });
    seed('s1', null, { work: { label: 'keep me' } });
  });

  describe('noteTurnEnded', () => {
    it('ignores succeeded turns and errors that are not limits', async () => {
      await autoResume.noteTurnEnded('s1', 'succeeded', LIMIT_ERROR);
      await autoResume.noteTurnEnded('s1', 'failed', { message: 'file not found' });
      await autoResume.noteTurnEnded('s1', 'failed', undefined);
      expect(stateOf()).toBeNull();
      expect(announced).toEqual([]);
    });

    it('records the reset without arming a timer while the toggle is off', async () => {
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      expect(stateOf()).toMatchObject({ enabled: false, status: 'idle', resumeAt: NOW + 2 * HOUR, resetWindow: 'error' });
      expect(scheduled.size).toBe(0);
      expect(autoResume.isPending('s1')).toBe(false);
    });

    it('schedules and arms a timer while the toggle is on', async () => {
      seed('s1', { enabled: true, status: 'idle' });
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      expect(stateOf()).toMatchObject({ enabled: true, status: 'scheduled', resumeAt: NOW + 2 * HOUR });
      expect(scheduled.size).toBe(1);
      expect([...scheduled.values()][0].delay).toBe(2 * HOUR);
    });

    it('resumes with the stored prompt when the timer fires, then goes idle', async () => {
      seed('s1', { enabled: true, status: 'idle', prompt: 'Continue with the tests.' });
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      await fireTimer();
      expect(resumed).toEqual([{ sessionId: 's1', text: 'Continue with the tests.' }]);
      expect(stateOf()).toMatchObject({ status: 'idle', resumeAt: null, resetWindow: null, lastError: null });
      expect(autoResume.isPending('s1')).toBe(false);
    });

    it('resumes with the default prompt when none is stored', async () => {
      seed('s1', { enabled: true, status: 'idle' });
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      await fireTimer();
      expect(resumed[0].text).toBe(DEFAULT_RESUME_PROMPT);
    });

    it('marks the session failed with the error when resuming throws', async () => {
      seed('s1', { enabled: true, status: 'idle' });
      resumeBehavior = async () => {
        throw new Error('engine gone');
      };
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      await fireTimer();
      expect(stateOf()).toMatchObject({ status: 'failed', lastError: 'engine gone' });
    });

    it('does nothing for an unknown session', async () => {
      await autoResume.noteTurnEnded('missing', 'failed', LIMIT_ERROR);
      expect(announced).toEqual([]);
    });
  });

  describe('fire', () => {
    it('keeps a status that resumeSession itself rescheduled', async () => {
      seed('s1', { enabled: true, status: 'idle' });
      resumeBehavior = async (session) => {
        const current = sessions.get(session.id);
        sessions.set(session.id, {
          ...current,
          metadata: { openchamber: { ...current.metadata.openchamber, autoResume: { ...readAutoResume(current), status: 'scheduled', resumeAt: NOW + 3 * HOUR } } },
        });
      };
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      await fireTimer();
      expect(stateOf()).toMatchObject({ status: 'scheduled', resumeAt: NOW + 3 * HOUR });
    });

    it('does nothing when the toggle was turned off meanwhile', async () => {
      seed('s1', { enabled: false, status: 'scheduled', resumeAt: NOW + HOUR });
      await autoResume.fire('s1');
      expect(resumed).toEqual([]);
    });
  });

  describe('configure', () => {
    it('uses a recorded future reset when enabled without a time', async () => {
      await autoResume.noteTurnEnded('s1', 'failed', LIMIT_ERROR);
      const state = await autoResume.configure('s1', { enabled: true });
      expect(state).toMatchObject({ enabled: true, status: 'scheduled', resumeAt: NOW + 2 * HOUR, resetWindow: 'error' });
      expect([...scheduled.values()][0].delay).toBe(2 * HOUR);
    });

    it('waits the fallback 30 minutes when no future reset is recorded', async () => {
      seed('s1', { enabled: false, status: 'idle', resumeAt: NOW - HOUR });
      const state = await autoResume.configure('s1', { enabled: true });
      expect(state.resumeAt).toBe(NOW + 30 * MINUTE);

      seed('s2', null);
      expect((await autoResume.configure('s2', { enabled: true })).resumeAt).toBe(NOW + 30 * MINUTE);
    });

    it('marks an explicit time as chosen by the user', async () => {
      const state = await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
      expect(state).toMatchObject({ resumeAt: NOW + HOUR, resetWindow: 'user', status: 'scheduled' });
    });

    it('stores a trimmed prompt and clears a blank one', async () => {
      expect((await autoResume.configure('s1', { enabled: true, prompt: '  go on  ' })).prompt).toBe('go on');
      expect((await autoResume.configure('s1', { enabled: true, prompt: '   ' })).prompt).toBeNull();
    });

    it('cancels the timer when turned off', async () => {
      await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
      expect(scheduled.size).toBe(1);
      const state = await autoResume.configure('s1', { enabled: false });
      expect(scheduled.size).toBe(0);
      expect(state).toMatchObject({ enabled: false, status: 'idle' });
    });

    it('returns null for an unknown session', async () => {
      expect(await autoResume.configure('missing', { enabled: true })).toBeNull();
    });

    it('re-arms with a single timer when configured twice', async () => {
      await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
      await autoResume.configure('s1', { enabled: true, resumeAt: NOW + 2 * HOUR });
      expect(scheduled.size).toBe(1);
    });
  });

  describe('noteUserPrompt', () => {
    it('cancels a pending resume', async () => {
      await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
      await autoResume.noteUserPrompt('s1');
      expect(scheduled.size).toBe(0);
      expect(stateOf()).toMatchObject({ enabled: true, status: 'idle', resumeAt: null });
    });

    it('does nothing when no resume is pending', async () => {
      await autoResume.noteUserPrompt('s1');
      expect(announced).toEqual([]);
    });
  });

  describe('restore', () => {
    it('re-arms scheduled sessions and fails one that was running', async () => {
      seed('s1', { enabled: true, status: 'scheduled', resumeAt: NOW + HOUR });
      seed('s2', { enabled: true, status: 'running', resumeAt: NOW - MINUTE });
      seed('s3', { enabled: false, status: 'scheduled', resumeAt: NOW + HOUR });
      await autoResume.restore();
      expect(autoResume.isPending('s1')).toBe(true);
      expect(autoResume.isPending('s3')).toBe(false);
      expect(scheduled.size).toBe(1);
      expect(stateOf('s2')).toMatchObject({ status: 'failed' });
      expect(stateOf('s2').lastError).toContain('restarted');
    });
  });

  describe('announce', () => {
    it('sends the full metadata and keeps the other openchamber keys', async () => {
      await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
      const last = announced.at(-1);
      expect(last.sessionId).toBe('s1');
      expect(last.metadata.openchamber.work).toEqual({ label: 'keep me' });
      expect(last.metadata.openchamber.autoResume).toMatchObject({ enabled: true, status: 'scheduled' });
      expect(sessions.get('s1').metadata).toEqual(last.metadata);
    });
  });

  it('stop cancels every pending timer', async () => {
    await autoResume.configure('s1', { enabled: true, resumeAt: NOW + HOUR });
    autoResume.stop();
    expect(scheduled.size).toBe(0);
    expect(autoResume.isPending('s1')).toBe(false);
  });

  it('re-arms in chunks for a wait beyond the timer limit', async () => {
    const farAway = 40 * 24 * HOUR;
    await autoResume.configure('s1', { enabled: true, resumeAt: NOW + farAway });
    expect([...scheduled.values()][0].delay).toBe(2_147_483_647);
    await fireTimer();
    expect(resumed).toEqual([]);
    expect(scheduled.size).toBe(1);
  });
});
