import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { cx } from './ui';

/** Panels whose width the user can drag. Widths are shared by all connections and remembered. */
export const PANELS = {
  sidebar: { initial: 256, min: 180, max: 520 },
  rowPanel: { initial: 300, min: 220, max: 640 },
  claude: { initial: 380, min: 300, max: 720 },
} as const;
export type PanelKey = keyof typeof PANELS;

const KEY = 'rowline.panelWidths';

/** Keeps a width inside the panel's limits and never wider than half the window. */
export function clampWidth(panel: PanelKey, width: number, windowWidth = typeof window === 'undefined' ? 4000 : window.innerWidth): number {
  const { min, max } = PANELS[panel];
  return Math.round(Math.max(min, Math.min(max, windowWidth / 2, width)));
}

function readWidths(): Partial<Record<PanelKey, number>> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<PanelKey, number>>;
    // older versions stored the Claude panel width on its own
    const oldClaude = Number(localStorage.getItem('rowline.claudeWidth'));
    if (!saved.claude && oldClaude) saved.claude = oldClaude;
    return saved;
  } catch {
    return {};
  }
}

interface WidthState {
  widths: Partial<Record<PanelKey, number>>;
  set: (panel: PanelKey, width: number) => void;
  reset: (panel: PanelKey) => void;
}

export const usePanelWidths = create<WidthState>((set, get) => {
  const save = (widths: Partial<Record<PanelKey, number>>) => {
    set({ widths });
    try {
      localStorage.setItem(KEY, JSON.stringify(widths));
    } catch {
      /* storage not available */
    }
  };
  return {
    widths: readWidths(),
    set: (panel, width) => save({ ...get().widths, [panel]: clampWidth(panel, width) }),
    reset: (panel) => {
      const { [panel]: _gone, ...rest } = get().widths;
      save(rest);
    },
  };
});

export function usePanelWidth(panel: PanelKey): number {
  return clampWidth(panel, usePanelWidths((s) => s.widths[panel]) ?? PANELS[panel].initial);
}

/**
 * The drag strip on one edge of a panel. `edge` is the side of the panel it sits on:
 * "right" for the left sidebar (drag right = wider), "left" for panels on the right (drag left = wider).
 * Double-click restores the default width.
 */
export function ResizeHandle({ panel, edge }: { panel: PanelKey; edge: 'left' | 'right' }) {
  const width = usePanelWidth(panel);
  const stopRef = useRef<(() => void) | null>(null);
  // the panel may close mid-drag: remove the listeners then too
  useEffect(() => () => stopRef.current?.(), []);

  const start = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      usePanelWidths.getState().set(panel, startWidth + (edge === 'right' ? delta : -delta));
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      stopRef.current = null;
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    stopRef.current = stop;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize"
      title="Drag to resize · double-click to reset"
      className={cx(
        'group absolute inset-y-0 z-20 w-2 cursor-col-resize',
        edge === 'right' ? '-right-1' : '-left-1',
      )}
      onMouseDown={start}
      onDoubleClick={() => usePanelWidths.getState().reset(panel)}
      data-testid={`resize-${panel}`}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-accent" />
    </div>
  );
}
