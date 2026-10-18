import { describe, it, expect } from 'bun:test';
import { buildToolInstructions } from './tool-instructions.js';

describe('buildToolInstructions', () => {
  it('says nothing when the server lists no tool', () => {
    expect(buildToolInstructions([])).toBeNull();
    expect(buildToolInstructions(['unrelated'])).toBeNull();
  });

  it('tells the engine to drive the browser panel with openchamber_web, not generic tools', () => {
    const text = buildToolInstructions(['openchamber_web']);
    expect(text).toContain('openchamber_web');
    expect(text).toContain('not computer-use');
  });

  it('states the drivable limit and a fallback instead of claiming success', () => {
    const text = buildToolInstructions(['openchamber_web']);
    expect(text).toContain('`drivable`');
    expect(text).toContain('only displayed');
    expect(text).toContain('do not report the task as done');
    expect(text).toContain('desktop app');
  });

  it('requires a failed call to be reported as failed', () => {
    expect(buildToolInstructions(['openchamber_render'])).toContain('say it failed');
  });

  it('sends diagrams, charts and tables to the render tool after one guide call', () => {
    const text = buildToolInstructions(['openchamber_render', 'openchamber_render_guide']);
    expect(text).toContain('Call openchamber_render_guide once before your first openchamber_render in a session');
    for (const kind of ['diagram', 'chart', 'schema', 'flowchart', 'mockup', 'comparison table']) expect(text).toContain(kind);
    expect(text).toContain('instead of ASCII art or Mermaid code blocks');
    expect(buildToolInstructions(['openchamber_render'])).not.toContain('openchamber_render_guide');
  });

  it('describes only the tools the settings turn on', () => {
    const text = buildToolInstructions(['openchamber_render', 'openchamber_knowledge']);
    expect(text).toContain('openchamber_render');
    expect(text).toContain('openchamber_knowledge');
    expect(text).not.toContain('openchamber_web');
    expect(text).not.toContain('openchamber_notify');
  });
});
