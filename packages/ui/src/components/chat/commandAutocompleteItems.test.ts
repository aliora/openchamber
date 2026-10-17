import { describe, expect, test } from 'bun:test';
import { mergeSkillsIntoCommandItems, rankCommandAutocompleteItems } from './commandAutocompleteItems';

type Item = { name: string; kind?: 'command' | 'skill' };

describe('mergeSkillsIntoCommandItems', () => {
  test('drops skills named like a command, ignoring case', () => {
    const commands: Item[] = [{ name: 'review' }, { name: 'init' }];
    const skills: Item[] = [{ name: 'review', kind: 'skill' }, { name: 'INIT', kind: 'skill' }];
    expect(mergeSkillsIntoCommandItems(commands, skills)).toEqual(commands);
  });

  test('appends remaining skills after commands', () => {
    const commands: Item[] = [{ name: 'init' }];
    const skills: Item[] = [{ name: 'deploy', kind: 'skill' }, { name: 'init', kind: 'skill' }];
    expect(mergeSkillsIntoCommandItems(commands, skills).map((item) => item.name)).toEqual(['init', 'deploy']);
  });

  test('handles empty inputs', () => {
    expect(mergeSkillsIntoCommandItems([], [])).toEqual([]);
    expect(mergeSkillsIntoCommandItems([{ name: 'init' }], [])).toEqual([{ name: 'init' }]);
    expect(mergeSkillsIntoCommandItems([], [{ name: 'deploy', kind: 'skill' }]).length).toBe(1);
  });

  test('ranks merged skills by query like commands', () => {
    const merged = mergeSkillsIntoCommandItems<Item>(
      [{ name: 'undo' }, { name: 'redo' }],
      [{ name: 'deploy', kind: 'skill' }, { name: 'debug-helper', kind: 'skill' }],
    );
    expect(rankCommandAutocompleteItems(merged, 'deploy')[0]).toEqual({ name: 'deploy', kind: 'skill' });
  });
});
