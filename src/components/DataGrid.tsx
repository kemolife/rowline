import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type DataEditorRef,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { boolValue, weekdayName, type ColumnMeta } from '../lib/columns';
import { isSqlExpr, type Cell, type ResultColumn, type SortSpec } from '../lib/types';
import { cellStats, formatCell, formatNumber, withAlpha } from '../lib/ui';
import { useApp } from '../store/app';

export type RowState = 'edited' | 'inserted' | 'deleted' | null;

export interface DataGridProps {
  columns: ResultColumn[];
  /** header badges, type hints and value styles; same order as `columns` */
  meta?: ColumnMeta[];
  rowCount: number;
  getValue: (row: number, col: number) => Cell;
  getRowState?: (row: number) => RowState;
  isCellEdited?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: string) => void;
  onSelectRows?: (rows: number[]) => void;
  sort?: SortSpec[];
  onHeaderClick?: (column: string) => void;
  /** Delete key on rows selected with the row numbers */
  onDeleteRows?: (rows: number[]) => void;
  /** Right click on a cell; x/y are window coordinates */
  onCellMenu?: (row: number, col: number, x: number, y: number) => void;
  /** click on the ↗ of a foreign key cell, or ⌘-click anywhere in it */
  onOpenForeignKey?: (row: number, col: number) => void;
}

export interface DataGridHandle {
  focus: () => void;
  clearSelection: () => void;
  /** scrolls to a row and selects it (first cell) */
  selectRow: (row: number) => void;
}

/** NULL is shown as a faint dash, so real values stand out */
export const NULL_MARK = '—';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();


/** Colors read from the CSS variables; recomputed when the theme changes */
interface Palette {
  text: string;
  text3: string;
  nullFaint: string;
  link: string;
  sel: string;
  selStrong: string;
  edited: string;
  inserted: string;
  deleted: string;
  pkBg: string;
  pkFg: string;
  fkBg: string;
  fkFg: string;
  mono: string;
  ui: string;
}

function useThemeKey() {
  const mode = useApp((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq?.addEventListener('change', fn);
    return () => mq?.removeEventListener('change', fn);
  }, []);
  return `${mode}-${systemDark}`;
}

function useGridTheme(themeKey: string): { theme: Partial<Theme>; palette: Palette } {
  return useMemo(() => {
    void themeKey;
    const mono = css('--font-mono') || 'ui-monospace, monospace';
    const palette: Palette = {
      text: css('--text'),
      text3: css('--text-3'),
      nullFaint: css('--null-faint'),
      link: css('--link'),
      sel: css('--sel'),
      selStrong: css('--sel-strong'),
      edited: css('--edited'),
      inserted: css('--inserted'),
      deleted: css('--deleted'),
      pkBg: css('--badge-pk'),
      pkFg: css('--warning'),
      fkBg: css('--badge-fk'),
      fkFg: css('--link'),
      mono,
      ui: css('--font-ui') || 'system-ui, sans-serif',
    };
    const theme: Partial<Theme> = {
      accentColor: palette.selStrong,
      accentFg: '#ffffff',
      accentLight: withAlpha(palette.selStrong, 0.16),
      textDark: palette.text,
      textMedium: css('--text-2'),
      textLight: palette.text3,
      textBubble: palette.text,
      bgIconHeader: palette.text3,
      fgIconHeader: css('--surface'),
      textHeader: css('--text-2'),
      textHeaderSelected: '#ffffff',
      bgCell: css('--surface'),
      bgCellMedium: css('--surface-2'),
      bgHeader: css('--bg'),
      bgHeaderHasFocus: css('--surface-2'),
      bgHeaderHovered: css('--surface-2'),
      bgBubble: css('--surface-2'),
      bgBubbleSelected: css('--surface-3'),
      bgSearchResult: palette.edited,
      borderColor: css('--border'),
      horizontalBorderColor: css('--border'),
      headerBottomBorderColor: css('--border-strong'),
      drilldownBorder: css('--border-strong'),
      linkColor: palette.link,
      cellHorizontalPadding: 10,
      cellVerticalPadding: 4,
      headerFontStyle: '600 11.5px',
      baseFontStyle: '12px',
      markerFontStyle: '11px',
      fontFamily: mono,
      editorFontSize: '12px',
      lineHeight: 1.4,
    };
    return { theme, palette };
  }, [themeKey]);
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7.5;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

const PAD = 10;
const ARROW = '↗';
const ARROW_W = 16;
const BADGE_FONT = (ui: string) => `700 9px ${ui}`;

/** Where the ↗ of a foreign key cell is drawn: before a right-aligned value, at the right edge otherwise */
function fkArrowX(rect: { x: number; width: number }, alignRight: boolean, valueWidth: number): number {
  return alignRight ? rect.x + rect.width - PAD - valueWidth - ARROW_W - 2 : rect.x + rect.width - PAD - ARROW_W + 2;
}

const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(props, ref) {
  const { columns, meta, rowCount, getValue, getRowState, isCellEdited, editable, onEdit, onSelectRows, sort, onHeaderClick, onDeleteRows, onCellMenu, onOpenForeignKey } = props;
  const themeKey = useThemeKey();
  const { theme, palette } = useGridTheme(themeKey);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [moreRight, setMoreRight] = useState(false);
  /** foreign key cell whose ↗ button is under the mouse: `col,row` */
  const [fkHover, setFkHover] = useState<string | null>(null);
  const editorRef = useRef<DataEditorRef | null>(null);

  const cellFont = `${theme.baseFontStyle} ${palette.mono}`;
  const colMeta = useCallback((i: number): ColumnMeta | undefined => meta?.[i], [meta]);
  const alignRight = useCallback((col: number, value: Cell) => typeof value === 'number' || !!colMeta(col)?.numeric, [colMeta]);

  const reportRows = useCallback(
    (sel: GridSelection) => {
      const rows = new Set<number>(sel.rows.toArray());
      if (sel.current) {
        const r = sel.current.range;
        for (let i = r.y; i < r.y + r.height; i++) rows.add(i);
      }
      setSelectedRows(rows);
      onSelectRows?.([...rows].sort((a, b) => a - b));
    },
    [onSelectRows],
  );

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clearSelection: () => {
      setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
      setSelectedRows(new Set());
    },
    selectRow: (row: number) => {
      const sel: GridSelection = {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: { cell: [0, row], range: { x: 0, y: row, width: 1, height: 1 }, rangeStack: [] },
      };
      setSelection(sel);
      reportRows(sel);
      // no focus() here: focusing the grid makes it reset the selection to its first cell
      editorRef.current?.scrollTo(0, row, 'vertical', 0, 0, { vAlign: 'center' });
    },
  }));

  // widths from header (name + badge, type hint) and the first rows; NULL takes only a dash
  const autoWidths = useMemo(() => {
    const head = `600 11.5px ${palette.mono}`;
    return columns.map((c, ci) => {
      const m = meta?.[ci];
      const badge = m?.primaryKey || m?.foreignKey ? 22 : 0;
      let w = Math.max(textWidth(c.name, head) + badge + 30, textWidth(m?.typeHint ?? '', `10.5px ${palette.mono}`) + 24);
      if (m?.boolean) w = Math.max(w, 56);
      else
        for (let r = 0; r < Math.min(rowCount, 80); r++) {
          const v = getValue(r, ci);
          const text = v === null ? NULL_MARK : formatCell(v).slice(0, 80);
          let cw = textWidth(text, cellFont) + 2 * PAD + 4;
          if (m?.foreignKey && v !== null) cw += ARROW_W;
          if (m?.weekday && weekdayName(v)) cw += 34;
          w = Math.max(w, cw);
        }
      return Math.round(Math.min(Math.max(w, 56), 380));
    });
    // only recompute when the column set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, meta]);

  const gridColumns: GridColumn[] = useMemo(
    () => columns.map((c, i) => ({ id: c.name, title: c.name, width: widths[c.name] ?? autoWidths[i] ?? 120 })),
    [columns, widths, autoWidths],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const value = getValue(row, col);
      const m = colMeta(col);
      const state = getRowState?.(row) ?? null;
      const readonly = !editable || state === 'deleted';
      const edited = isCellEdited?.(row, col) ?? false;
      const editedBg = edited ? { bgCell: palette.edited } : {};

      if (m?.boolean && !isSqlExpr(value)) {
        return {
          kind: GridCellKind.Boolean,
          data: boolValue(value),
          allowOverlay: false,
          readonly,
          themeOverride: edited ? editedBg : undefined,
        };
      }
      const isNull = value === null;
      // DEFAULT / CURRENT_TIMESTAMP set from the row panel: shown faint, edited as an empty field
      const isExpr = isSqlExpr(value);
      const text = isNull ? NULL_MARK : formatCell(value);
      return {
        kind: GridCellKind.Text,
        data: isNull || isExpr ? '' : text,
        displayData: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        allowOverlay: true,
        readonly,
        themeOverride: isNull
          ? { textDark: palette.nullFaint, ...editedBg }
          : isExpr
            ? { textDark: palette.text3, ...editedBg }
            : m?.foreignKey
              ? { textDark: palette.link, ...editedBg }
              : edited
                ? editedBg
                : undefined,
        contentAlign: alignRight(col, value) ? 'right' : undefined,
        cursor: fkHover === `${col},${row}` ? 'pointer' : undefined,
      };
    },
    [getValue, colMeta, getRowState, isCellEdited, editable, palette, alignRight, fkHover],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const state = getRowState?.(row);
      if (state === 'inserted') return { bgCell: palette.inserted };
      if (state === 'deleted') return { bgCell: palette.deleted, textDark: palette.text3 };
      if (selectedRows.has(row)) return { bgCell: palette.sel };
      return undefined;
    },
    [getRowState, selectedRows, palette],
  );

  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, col, row, cell } = args;
      // the grid keeps canvas settings between cells: everything drawn here is undone afterwards,
      // otherwise the next cells take this color and font (blue ids, grey numbers)
      ctx.save();
      try {
        if (col === 0 && selectedRows.has(row)) {
          // selected row marker
          ctx.fillStyle = palette.selStrong;
          ctx.fillRect(rect.x, rect.y, 3, rect.height);
        }
        const m = colMeta(col);
        if (!m || cell.kind !== GridCellKind.Text) return;
        const value = getValue(row, col);
        if (value === null || isSqlExpr(value)) return;
        const right = alignRight(col, value);
        const valueW = right ? textWidth(cell.displayData, cellFont) : 0;
        const midY = rect.y + rect.height / 2;
        if (m.foreignKey) {
          // a small button: ↗ opens the related row
          const x = fkArrowX(rect, right, valueW);
          const hot = fkHover === `${col},${row}`;
          ctx.fillStyle = hot ? palette.selStrong : palette.fkBg;
          ctx.beginPath();
          ctx.roundRect(x - 2, midY - 8, ARROW_W, 16, 4);
          ctx.fill();
          ctx.font = `600 10px ${palette.ui}`;
          ctx.fillStyle = hot ? '#ffffff' : palette.link;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(ARROW, x - 2 + ARROW_W / 2, midY + 0.5);
        } else if (m.weekday && right) {
          const day = weekdayName(value);
          if (!day) return;
          ctx.font = `11px ${palette.ui}`;
          ctx.fillStyle = palette.text3;
          ctx.textBaseline = 'middle';
          const dw = ctx.measureText(day).width;
          ctx.fillText(day, rect.x + rect.width - PAD - valueW - 6 - dw, midY + 0.5);
        }
      } finally {
        ctx.restore();
      }
    },
    [selectedRows, palette, colMeta, getValue, alignRight, cellFont, fkHover],
  );

  /** is the mouse on the ↗ button of a foreign key cell? */
  const onFkButton = useCallback(
    (col: number, row: number, localX: number, width: number) => {
      if (!colMeta(col)?.foreignKey || !onOpenForeignKey) return false;
      const value = getValue(row, col);
      if (value === null || isSqlExpr(value)) return false;
      const right = alignRight(col, value);
      const valueW = right ? textWidth(formatCell(value), cellFont) : 0;
      const ax = fkArrowX({ x: 0, width }, right, valueW);
      return localX >= ax - 4 && localX <= ax + ARROW_W;
    },
    [colMeta, onOpenForeignKey, getValue, alignRight, cellFont],
  );

  const drawHeader: DrawHeaderCallback = useCallback(
    (args) => {
      const { ctx, rect, columnIndex } = args;
      const c = columns[columnIndex];
      if (!c) return;
      const m = colMeta(columnIndex);
      const s = sort?.find((x) => x.column === c.name);
      const right = !!m?.numeric;
      const badge = m?.primaryKey ? 'PK' : m?.foreignKey ? 'FK' : null;
      const nameFont = `600 11.5px ${palette.mono}`;
      const arrow = s ? (s.descending ? ' ↓' : ' ↑') : '';
      const badgeW = badge ? textWidth(badge, BADGE_FONT(palette.ui)) + 8 : 0;
      const nameW = textWidth(c.name, nameFont);
      const arrowW = arrow ? textWidth(arrow, nameFont) : 0;
      const lineW = badgeW + (badge ? 5 : 0) + nameW + arrowW;
      const y1 = rect.y + 14;
      const y2 = rect.y + 29;

      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.textBaseline = 'middle';
      let x = right ? Math.max(rect.x + PAD, rect.x + rect.width - PAD - lineW) : rect.x + PAD;
      if (badge) {
        ctx.fillStyle = badge === 'PK' ? palette.pkBg : palette.fkBg;
        ctx.beginPath();
        ctx.roundRect(x, y1 - 6.5, badgeW, 13, 3);
        ctx.fill();
        ctx.font = BADGE_FONT(palette.ui);
        ctx.fillStyle = badge === 'PK' ? palette.pkFg : palette.fkFg;
        ctx.fillText(badge, x + 4, y1 + 0.5);
        x += badgeW + 5;
      }
      ctx.font = nameFont;
      ctx.fillStyle = palette.text;
      ctx.fillText(c.name, x, y1);
      if (arrow) {
        ctx.fillStyle = palette.selStrong;
        ctx.fillText(arrow, x + nameW, y1);
      }
      if (m?.typeHint) {
        ctx.font = `10.5px ${palette.mono}`;
        ctx.fillStyle = palette.text3;
        const tw = textWidth(m.typeHint, ctx.font);
        ctx.fillText(m.typeHint, right ? Math.max(rect.x + PAD, rect.x + rect.width - PAD - tw) : rect.x + PAD, y2);
      }
      // a column without structure info (query results) keeps the default single line
      ctx.restore();
    },
    [columns, colMeta, sort, palette],
  );

  // totals of the selected cells (like a spreadsheet status bar); at most 200k cells are read
  const stats = useMemo(() => {
    const ranges = selection.current ? [selection.current.range, ...selection.current.rangeStack] : [];
    const values: Cell[] = [];
    for (const r of ranges) {
      for (let y = r.y; y < r.y + r.height && values.length < 200_000; y++) {
        for (let x = r.x; x < r.x + r.width; x++) values.push(getValue(y, x));
      }
    }
    return cellStats(values);
  }, [selection, getValue]);

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (newValue.kind === GridCellKind.Boolean) {
        onEdit?.(row, col, newValue.data ? '1' : '0');
        return;
      }
      if (newValue.kind !== GridCellKind.Text) return;
      // opening the editor on NULL / DEFAULT and leaving it empty keeps the value
      const old = getValue(row, col);
      if (newValue.data === '' && (old === null || isSqlExpr(old))) return;
      onEdit?.(row, col, newValue.data);
    },
    [onEdit, getValue],
  );

  const onSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel);
      reportRows(sel);
    },
    [reportRows],
  );

  return (
    <div className="relative min-h-0 flex-1" data-testid="data-grid">
      <DataEditor
        ref={editorRef}
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={rowCount}
        getCellContent={getCellContent}
        getRowThemeOverride={getRowThemeOverride}
        drawCell={drawCell}
        drawHeader={meta ? drawHeader : undefined}
        onCellEdited={editable ? onCellEdited : undefined}
        gridSelection={selection}
        onGridSelectionChange={onSelectionChange}
        getCellsForSelection
        rowMarkers="clickable-number"
        smoothScrollX
        smoothScrollY
        rowHeight={28}
        headerHeight={meta ? 40 : 30}
        theme={theme}
        onColumnResize={(col, newSize) => setWidths((w) => ({ ...w, [String(col.id)]: newSize }))}
        onHeaderClicked={(i) => onHeaderClick?.(columns[i].name)}
        onVisibleRegionChanged={(range) => setMoreRight(range.x + range.width < columns.length)}
        onCellClicked={([col, row], e) => {
          if (!colMeta(col)?.foreignKey || !onOpenForeignKey) return;
          const value = getValue(row, col);
          if (value === null || isSqlExpr(value)) return;
          if (e.metaKey || e.ctrlKey || onFkButton(col, row, e.localEventX, e.bounds.width)) onOpenForeignKey(row, col);
        }}
        onItemHovered={(e) => {
          const key = e.kind === 'cell' && onFkButton(e.location[0], e.location[1], e.localEventX, e.bounds.width) ? `${e.location[0]},${e.location[1]}` : null;
          setFkHover((cur) => (cur === key ? cur : key));
        }}
        onCellContextMenu={([col, row], e) => {
          if (!onCellMenu || col < 0) return;
          e.preventDefault();
          onCellMenu(row, col, e.bounds.x + e.localEventX, e.bounds.y + e.localEventY);
        }}
        onDelete={(sel) => {
          // whole rows (picked with the row numbers): mark them for deletion instead of emptying their cells
          const rows = sel.rows.toArray();
          if (!rows.length) return true;
          onDeleteRows?.(rows);
          return false;
        }}
        keybindings={{ search: true, copy: true, paste: !!editable, selectAll: true }}
      />
      {stats && (
        <div
          className="pointer-events-none absolute bottom-2 right-3 z-10 flex gap-3 rounded-md border border-line bg-surface/95 px-2.5 py-1 text-[11.5px] tabular-nums text-ink-2 shadow-sm"
          data-testid="selection-stats"
        >
          <span>
            <span className="text-ink-3">Count</span> {formatNumber(stats.count)}
          </span>
          {stats.numbers > 0 && (
            <>
              <span>
                <span className="text-ink-3">Sum</span> {formatNumber(stats.sum)}
              </span>
              <span>
                <span className="text-ink-3">Avg</span> {formatNumber(stats.avg)}
              </span>
              <span>
                <span className="text-ink-3">Min</span> {formatNumber(stats.min)}
              </span>
              <span>
                <span className="text-ink-3">Max</span> {formatNumber(stats.max)}
              </span>
            </>
          )}
        </div>
      )}
      {/* there are more columns to the right */}
      {moreRight && <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-5 bg-gradient-to-l from-black/10 to-transparent" />}
    </div>
  );
});

export default DataGrid;
