import { beforeEach, describe, expect, it } from 'vitest';
import { moveLegacyKeys } from './legacyStorage';

describe('legacy storage keys', () => {
  beforeEach(() => localStorage.clear());

  it('moves tabula.* keys to rowline.* and keeps newer values', () => {
    localStorage.setItem('tabula.theme', 'light');
    localStorage.setItem('tabula.tabs.c1', '[1]');
    localStorage.setItem('tabula.panelWidths', '{"sidebar":200}');
    localStorage.setItem('rowline.panelWidths', '{"sidebar":300}');
    localStorage.setItem('other', 'x');
    moveLegacyKeys(localStorage);
    expect(localStorage.getItem('rowline.theme')).toBe('light');
    expect(localStorage.getItem('rowline.tabs.c1')).toBe('[1]');
    expect(localStorage.getItem('rowline.panelWidths')).toBe('{"sidebar":300}');
    expect(localStorage.getItem('tabula.theme')).toBeNull();
    expect(localStorage.getItem('other')).toBe('x');
  });
});
