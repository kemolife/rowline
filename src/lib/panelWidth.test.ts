import { describe, expect, it } from 'vitest';
import { PANELS, clampWidth, usePanelWidths } from './panelWidth';

describe('panel widths', () => {
  it('stay inside the limits and at most half the window', () => {
    expect(clampWidth('sidebar', 50, 2000)).toBe(PANELS.sidebar.min);
    expect(clampWidth('sidebar', 5000, 2000)).toBe(PANELS.sidebar.max);
    expect(clampWidth('claude', 700, 1000)).toBe(500);
    expect(clampWidth('rowPanel', 333.6, 2000)).toBe(334);
  });

  it('are remembered and can be reset', () => {
    usePanelWidths.getState().set('sidebar', 300);
    expect(usePanelWidths.getState().widths.sidebar).toBe(300);
    expect(JSON.parse(localStorage.getItem('rowline.panelWidths') ?? '{}').sidebar).toBe(300);
    usePanelWidths.getState().reset('sidebar');
    expect(usePanelWidths.getState().widths.sidebar).toBeUndefined();
  });
});
