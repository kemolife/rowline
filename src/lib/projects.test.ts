import { describe, expect, it } from 'vitest';
import { effectiveProjects, relativeTime, groupByProject, insertGrouped, namePrefix, projectBadge, projectColor } from './projects';

describe('projects', () => {
  it('gives each project a stable color and a short badge', () => {
    expect(projectColor('2Solar')).toBe(projectColor('2solar'));
    expect(projectColor('2Solar')).toMatch(/^#[0-9a-f]{6}$/);
    expect(projectBadge('2Solar')).toBe('2S');
    expect(projectBadge('legacy local docker')).toBe('LL');
  });

  it('groups connections by project, without a project last', () => {
    const g = groupByProject([{ id: 'a', group: 'Zeta' }, { id: 'b' }, { id: 'c', group: 'Alpha' }, { id: 'd', group: ' Zeta ' }]);
    expect(g.map((x) => [x.group, x.items.map((i) => i.id)])).toEqual([
      ['Alpha', ['c']],
      ['Zeta', ['a', 'd']],
      [null, ['b']],
    ]);
  });

  it('opens a connection next to the others of its project', () => {
    const groups: Record<string, string | null> = { a1: 'A', b1: 'B', a2: 'A', x: null };
    const of = (id: string) => groups[id];
    expect(insertGrouped(['a1', 'b1'], 'a2', of)).toEqual(['a1', 'a2', 'b1']);
    expect(insertGrouped(['a1', 'b1'], 'x', of)).toEqual(['a1', 'b1', 'x']);
    expect(insertGrouped(['b1'], 'a1', of)).toEqual(['b1', 'a1']);
  });

  it('takes the project word from a connection name', () => {
    expect(namePrefix('2Solar-staging DB')).toBe('2Solar');
    expect(namePrefix('prod 2solar')).toBe('2solar');
    expect(namePrefix('local dev')).toBeNull();
  });

  it('guesses projects from names and databases; typed projects win', () => {
    const c = (id: string, name: string, extra: { group?: string; database?: string; filePath?: string } = {}) => ({ id, name, ...extra });
    const p = effectiveProjects([
      c('a', '2solar dev'),
      c('b', '2Solar-prod'),
      c('c', 'billing local', { group: 'Billing' }),
      c('d', 'billing staging'),
      c('e', 'old server', { database: 'zonnepanelenaanbieders' }),
      c('f', 'new box', { database: 'zonnepanelenaanbieders' }),
      c('g', 'lonely one', { database: 'shop' }),
      c('h', 'notes', { filePath: '/x/notes.sqlite' }),
    ]);
    expect(p.get('a')).toEqual({ name: '2solar', auto: true });
    expect(p.get('b')).toEqual({ name: '2solar', auto: true });
    expect(p.get('c')).toEqual({ name: 'Billing', auto: false });
    // joins the typed project of the same name, even alone
    expect(p.get('d')).toEqual({ name: 'Billing', auto: true });
    expect(p.get('e')).toEqual({ name: 'zonnepanelenaanbieders', auto: true });
    expect(p.get('f')).toEqual({ name: 'zonnepanelenaanbieders', auto: true });
    expect(p.has('g')).toBe(false);
    expect(p.has('h')).toBe(false);
  });

  it('says when a connection was last used', () => {
    const now = new Date('2026-10-20T12:00:00Z').getTime();
    expect(relativeTime(undefined, now)).toBe('Never');
    expect(relativeTime(now - 20_000, now)).toBe('Just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 2 * 3600_000, now)).toBe('2 h ago');
    expect(relativeTime(now - 30 * 3600_000, now)).toBe('Yesterday');
    expect(relativeTime(now - 3 * 86400_000, now)).toBe('3 days ago');
    expect(relativeTime(now - 20 * 86400_000, now)).toBe('30 Sept');
  });
});

