import { ChevronLeft, ChevronRight, Download, Loader2, PanelRight, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, confirmDialog } from '../lib/api';
import {
  addInsert,
  countChanges,
  emptyHistory,
  pushChange,
  redo,
  removeInsert,
  rowKeyString,
  setCell,
  setInsertCell,
  toChangeSet,
  toggleDelete,
  undo,
  type History,
} from '../lib/changes';
import { columnMeta } from '../lib/columns';
import { exportRows } from '../lib/export';
import { compileFilter, ruleForValue, type FilterRule } from '../lib/filters';
import { structureWithKeys } from '../lib/virtualKeys';
import { useReferencing, useSchema, useVirtualKeys } from '../store/schema';
import type { Relation } from '../lib/diagram';
import { primaryKeyAt, validRowIndexes } from '../lib/rows';
import type { Cell, QueryResult, RowValues, SortSpec, TableStructure } from '../lib/types';
import { MOD, cx, formatCount, matchKey } from '../lib/ui';
import { useApp, type TableTab } from '../store/app';
import { useWs, useWsActions } from '../store/workspace';
import DataGrid, { type DataGridHandle, type RowState } from './DataGrid';
import ReviewDialog from './ReviewDialog';
import RowPanel from './RowPanel';
import StructureView from './StructureView';
import CellMenu from './CellMenu';
import ColumnsMenu, { HeaderMenu, type ColumnChoice } from './ColumnsMenu';
import { loadHidden, saveHidden, visibleIndexes } from '../lib/hiddenColumns';
import FilterBar, { type FilterBarHandle, type FilterMode } from './FilterBar';

const PAGE_SIZES = [100, 300, 1000];
let insertSeq = 0;

export default function DataTab({ tab, active }: { tab: TableTab; active: boolean }) {
  const session = useWs((w) => w.session);
  const { setDirty, updateTab, openTable } = useWsActions();
  const toast = useApp((s) => s.toast);
  const rowPanelOpen = useApp((s) => s.rowPanelOpen);
  const toggleRowPanel = useApp((s) => s.toggleRowPanel);
  const id = session.connectionId;
  const database = session.config.engine === 'mysql' ? tab.database : null;

  const [rawStructure, setStructure] = useState<TableStructure | null>(null);
  // virtual foreign keys count as foreign keys everywhere in the tab (FK arrows, row panel, structure)
  const virtualKeys = useVirtualKeys(id, database);
  const structure = useMemo(() => (rawStructure ? structureWithKeys(rawStructure, virtualKeys) : null), [rawStructure, virtualKeys]);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  // rows in the whole table while a filter is on (counted once per table and filter switch)
  const [tableTotal, setTableTotal] = useState<{ key: string; n: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(300);
  // filters and sort live on the tab (restored with it; a foreign key jump opens a tab with a filter)
  const sort = useMemo(() => tab.sort ?? [], [tab.sort]);
  const rules = useMemo(() => tab.filters ?? [], [tab.filters]);
  const filterMode: FilterMode = tab.filterMode ?? 'chips';
  const [sqlInput, setSqlInput] = useState(tab.sqlFilter ?? '');
  const [history, setHistory] = useState<History>(emptyHistory);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [review, setReview] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [cellMenu, setCellMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const gridRef = useRef<DataGridHandle>(null);
  const filterRef = useRef<FilterBarHandle>(null);
  const loadSeq = useRef(0);

  const changes = history.present;
  const pending = countChanges(changes);
  useEffect(() => setDirty(tab.id, pending), [tab.id, pending, setDirty]);

  // structure: needed for primary key, types and the Structure view
  useEffect(() => {
    let cancelled = false;
    api
      .tableStructure(id, database, tab.table)
      .then((s) => !cancelled && setStructure(s))
      .catch((e) => !cancelled && setStructureError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [id, database, tab.table]);

  const columnTypes = useMemo(() => Object.fromEntries(structure?.columns.map((c) => [c.name, c.dataType]) ?? []), [structure]);
  const filter = filterMode === 'sql' ? (tab.sqlFilter ?? '').trim() : (compileFilter(rules, session.config.engine, columnTypes) ?? '');

  // the row count runs once per table and filter (not on every page or sort change); Refresh and Save recount
  const countedFor = useRef<string | null>(null);
  const countSeq = useRef(0);

  const load = useCallback(async (recount = false) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    const request = { database, table: tab.table, filter: filter || null, sort, limit, offset };
    try {
      const res = await api.selectPage(id, request, tab.id);
      if (seq !== loadSeq.current) return;
      setResult(res);
      setSelectedRows([]);
      gridRef.current?.clearSelection();
      // total in the background; large tables can take a moment
      const key = `${id}/${database ?? ''}/${tab.table}`;
      const countKey = `${key}/${filter}`;
      if (recount || countedFor.current !== countKey) {
        countedFor.current = countKey;
        const cs = ++countSeq.current;
        setTotal(null);
        setCounting(true);
        api
          .countRows(id, request, tab.id)
          .then((n) => cs === countSeq.current && setTotal(n))
          .catch(() => undefined)
          .finally(() => cs === countSeq.current && setCounting(false));
      }
      if (filter && (recount || tableTotal?.key !== key))
        api
          .countRows(id, { ...request, filter: null }, tab.id)
          .then((n) => setTableTotal({ key, n }))
          .catch(() => undefined);
    } catch (e) {
      if (seq === loadSeq.current) setError((e as Error).message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tableTotal only skips a repeated count
  }, [id, database, tab.id, tab.table, filter, sort, limit, offset]);

  useEffect(() => {
    if (tab.view === 'data') load();
    // reload only when the query parameters change, not on every view switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const columns = useMemo(() => result?.columns ?? [], [result]);
  const filterColumns = useMemo(
    () => (structure?.columns.length ? structure.columns.map((c) => ({ name: c.name, type: c.dataType })) : columns.map((c) => ({ name: c.name, type: c.typeName }))),
    [structure, columns],
  );
  const meta = useMemo(() => (structure ? columnMeta(columns, structure) : undefined), [columns, structure]);
  const pkColumns = useMemo(() => structure?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [], [structure]);
  // hidden columns (remembered per table): the grid gets only the shown ones and maps back to real indexes
  const tableKey = `${id}/${database ?? ''}/${tab.table}`;
  const [hidden, setHiddenState] = useState<string[]>(() => loadHidden(tableKey));
  // a foreign key jump can reuse this tab for another table
  useEffect(() => setHiddenState(loadHidden(tableKey)), [tableKey]);
  const setHidden = useCallback(
    (next: string[]) => {
      setHiddenState(next);
      saveHidden(tableKey, next);
    },
    [tableKey],
  );
  const [headerMenu, setHeaderMenu] = useState<{ column: string; x: number; y: number } | null>(null);
  const shownIdx = useMemo(
    () =>
      visibleIndexes(
        columns.map((c) => c.name),
        hidden,
      ),
    [columns, hidden],
  );
  const gridColumns = useMemo(() => shownIdx.map((i) => columns[i]), [shownIdx, columns]);
  const gridMeta = useMemo(() => meta && shownIdx.map((i) => meta[i]), [shownIdx, meta]);
  const columnChoices = useMemo<ColumnChoice[]>(
    () => columns.map((c, i) => ({ name: c.name, type: structure?.columns.find((s) => s.name === c.name)?.dataType ?? c.typeName, key: pkColumns.includes(c.name) ? 'PK' : meta?.[i]?.foreignKey ? 'FK' : null })),
    [columns, structure, pkColumns, meta],
  );
  const onlyKeys = () => setHidden(columnChoices.filter((c) => !c.key).map((c) => c.name));
  const editable = tab.objectKind === 'table' && pkColumns.length > 0 && !!result && pkColumns.every((pk) => columns.some((c) => c.name === pk));
  const loadedCount = result?.rows.length ?? 0;
  const rowCount = loadedCount + changes.inserts.length;

  const rowKey = useCallback(
    (row: number): RowValues | null => (result ? primaryKeyAt(result.rows, columns, pkColumns, row) : null),
    [result, pkColumns, columns],
  );

  const getValue = useCallback(
    (row: number, col: number): Cell => {
      const name = columns[col]?.name;
      if (row < 0 || name === undefined) return null;
      if (row >= loadedCount) return changes.inserts[row - loadedCount]?.values[name] ?? null;
      const key = rowKey(row);
      if (key) {
        const upd = changes.updates[rowKeyString(key)];
        if (upd && name in upd.values) return upd.values[name];
      }
      return result?.rows[row]?.[col] ?? null;
    },
    [columns, loadedCount, changes, rowKey, result],
  );

  const getRowState = useCallback(
    (row: number): RowState => {
      if (row < 0) return null;
      if (row >= loadedCount) return row < loadedCount + changes.inserts.length ? 'inserted' : null;
      const key = rowKey(row);
      if (!key) return null;
      const k = rowKeyString(key);
      if (changes.deletes[k]) return 'deleted';
      if (changes.updates[k]) return 'edited';
      return null;
    },
    [loadedCount, rowKey, changes],
  );

  const isCellEdited = useCallback(
    (row: number, col: number) => {
      if (row < 0 || row >= loadedCount || !columns[col]) return false;
      const key = rowKey(row);
      const upd = key ? changes.updates[rowKeyString(key)] : undefined;
      return !!upd && columns[col].name in upd.values;
    },
    [loadedCount, rowKey, changes, columns],
  );

  const gridGetValue = useCallback((row: number, col: number) => getValue(row, shownIdx[col] ?? -1), [getValue, shownIdx]);
  const gridIsCellEdited = useCallback((row: number, col: number) => isCellEdited(row, shownIdx[col] ?? -1), [isCellEdited, shownIdx]);

  const editCell = useCallback(
    (row: number, col: number, value: Cell) => {
      if (row < 0 || !columns[col]) return;
      const name = columns[col].name;
      if (row >= loadedCount) {
        const ins = changes.inserts[row - loadedCount];
        if (ins) setHistory((h) => pushChange(h, (c) => setInsertCell(c, ins.id, name, value)));
        return;
      }
      const key = rowKey(row);
      if (!key) return;
      const original = result!.rows[row][col];
      setHistory((h) => pushChange(h, (c) => setCell(c, key, name, value, original)));
    },
    [columns, loadedCount, changes.inserts, rowKey, result],
  );

  const addRow = () => {
    if (!editable) return;
    const newRow = rowCount; // new rows are added after the loaded ones
    setHistory((h) => pushChange(h, (c) => addInsert(c, `n${++insertSeq}`)));
    // after the grid has the extra row: show it and select it, so it can be filled in at once
    requestAnimationFrame(() => gridRef.current?.selectRow(newRow));
  };

  const deleteRows = useCallback(
    (rows: number[]) => {
      if (!editable || !rows.length) return;
      setHistory((h) =>
        pushChange(h, (c) => {
          let next = c;
          for (const r of [...rows].sort((a, b) => b - a)) {
            if (r >= loadedCount) {
              const ins = next.inserts[r - loadedCount];
              if (ins) next = removeInsert(next, ins.id);
            } else {
              const key = rowKey(r);
              if (key) next = toggleDelete(next, key);
            }
          }
          return next;
        }),
      );
    },
    [editable, loadedCount, rowKey],
  );

  const startSave = useCallback(async () => {
    if (!pending) return;
    try {
      setReview(await api.previewChanges(id, database, tab.table, toChangeSet(changes)));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [pending, id, database, tab.table, changes, toast]);

  const applySave = useCallback(async () => {
    setSaving(true);
    try {
      const n = await api.applyChanges(id, database, tab.table, toChangeSet(changes));
      setReview(null);
      setHistory(emptyHistory());
      toast(`Saved · ${n} row${n === 1 ? '' : 's'} affected`, 'success');
      await load(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }, [id, database, tab.table, changes, toast, load]);

  const discard = async () => {
    if (pending && !(await confirmDialog(`Discard ${pending} unsaved change${pending > 1 ? 's' : ''}?`))) return;
    setHistory(emptyHistory());
  };

  // stops the page load and the row counts (KILL QUERY on the server); the grid keeps no half result
  const cancel = async () => {
    const wasLoading = loading;
    loadSeq.current++;
    countSeq.current++;
    countedFor.current = null;
    setLoading(false);
    setCounting(false);
    if (wasLoading) setError('Cancelled. The rows were not loaded.');
    await api.cancelQuery(id, tab.id).catch(() => undefined);
  };

  const refresh = async () => {
    if (pending && !(await confirmDialog('Refreshing discards unsaved changes. Continue?'))) return;
    setHistory(emptyHistory());
    load(true);
  };

  // keyboard shortcuts while this tab is visible
  useEffect(() => {
    if (!active || tab.view !== 'data') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (matchKey(e, 'mod+s')) {
        e.preventDefault();
        startSave();
      } else if (matchKey(e, 'mod+.')) {
        e.preventDefault();
        cancel();
      } else if (matchKey(e, 'mod+r')) {
        e.preventDefault();
        refresh();
      } else if (matchKey(e, 'mod+f')) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (!typing && matchKey(e, 'mod+backspace')) {
        e.preventDefault();
        deleteRows(validSelected);
      } else if (!typing && matchKey(e, 'mod+z')) {
        e.preventDefault();
        setHistory((h) => undo(h));
      } else if (!typing && (matchKey(e, 'mod+shift+z') || matchKey(e, 'mod+y'))) {
        e.preventDefault();
        setHistory((h) => redo(h));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Esc while loading stops the load. Capture phase: it runs before the filter box, which would clear the typed text.
  useEffect(() => {
    if (!active || tab.view !== 'data' || !loading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const setSort = (next: SortSpec[]) => {
    setOffset(0);
    updateTab(tab.id, { sort: next });
  };
  const setRules = (next: FilterRule[]) => {
    setOffset(0);
    updateTab(tab.id, { filters: next });
  };
  const onHeaderClick = (column: string) => {
    const cur = sort.find((s) => s.column === column);
    setSort(!cur ? [{ column, descending: false }] : !cur.descending ? [{ column, descending: true }] : []);
  };
  const applySql = () => {
    setOffset(0);
    updateTab(tab.id, { sqlFilter: sqlInput.trim() });
  };
  const clearSql = () => {
    setSqlInput('');
    setOffset(0);
    updateTab(tab.id, { sqlFilter: '' });
  };

  const suggestValues = useCallback(
    async (column: string) => (await api.commonValues(id, database, tab.table, column)).filter((v) => v !== null).map(String),
    [id, database, tab.table],
  );

  // tables whose rows point to rows of this table (real, virtual and guessed relations)
  const referencing = useReferencing(id, database, tab.table);
  /** Opens the rows of another table that point to this row */
  const openReferencing = (row: number, r: Relation) => {
    const col = columns.findIndex((c) => c.name === r.toColumns[0]);
    const value = col >= 0 ? getValue(row, col) : null;
    if (value === null) return;
    openTable(r.from, 'table', 'data', { filters: [ruleForValue(r.fromColumns[0], value)] });
  };

  /** Opens the row a foreign key cell points to: a new tab filtered to it, or this tab */
  const openRelated = async (row: number, col: number, sameTab = false) => {
    const fk = meta?.[col]?.foreignKey;
    const value = getValue(row, col);
    if (!fk || value === null) return;
    if (sameTab && pending && !(await confirmDialog(`Discard ${pending} unsaved change${pending > 1 ? 's' : ''}?`))) return;
    openTable(fk.table, 'table', 'data', { filters: [ruleForValue(fk.column, value)], replaceTabId: sameTab ? tab.id : undefined });
  };

  // the grid may report rows that do not exist (e.g. -1 for the header, or past the end after a reload)
  const validSelected = validRowIndexes(selectedRows, rowCount);
  const selectedRow = validSelected[0] ?? null;
  const deleteLabel = (() => {
    if (validSelected.length !== 1) return `Delete ${validSelected.length} rows…`;
    const key = rowKey(validSelected[0]);
    const v = key && pkColumns.length === 1 ? key[pkColumns[0]] : null;
    return v != null && typeof v !== 'object' ? `Delete row ${v}…` : 'Delete row…';
  })();
  const rowLabel = (() => {
    if (selectedRow == null) return null;
    if (getRowState(selectedRow) === 'inserted') return 'new';
    const key = rowKey(selectedRow);
    return key ? Object.entries(key).map(([k, v]) => `${k} ${v === null ? 'NULL' : String(v)}`).join(', ') : null;
  })();
  const from = loadedCount ? offset + 1 : 0;
  const to = offset + loadedCount;

  const toolbarEnd = (
    <>
      {loading ? (
        <button className="btn h-7 gap-1.5 px-2" onClick={cancel} title={`Stop loading (Esc or ${MOD}.)`} data-testid="cancel-load">
          <Loader2 size={13} className="animate-spin" /> <span className="@max-[820px]:hidden">Cancel</span>
        </button>
      ) : (
        <button className="btn btn-ghost h-7 gap-1.5 px-2" onClick={refresh} title={`Reload the data (${MOD}R)`} data-testid="refresh">
          <RefreshCw size={13} /> <span className="@max-[820px]:hidden">Refresh</span>
        </button>
      )}
      {result && <ColumnsMenu columns={columnChoices} hidden={hidden} onChange={setHidden} />}
      <button className={cx('btn btn-ghost h-7 gap-1.5 px-2', rowPanelOpen && 'bg-surface-2 text-ink')} onClick={toggleRowPanel} title="Show or hide all fields of the selected row" aria-label="Toggle row details">
        <PanelRight size={13} /> <span className="@max-[820px]:hidden">Row details</span>
      </button>
    </>
  );

  if (tab.view === 'structure') {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar>
          <ViewSwitch view="structure" onChange={(view) => updateTab(tab.id, { view })} />
          <div className="flex-1" />
        </Toolbar>
        <div className="min-h-0 flex-1 overflow-auto">
          {structure ? (
            <StructureView
              structure={structure}
              tables={session.objects.map((o) => o.name)}
              onAddVirtualKey={(k) => useSchema.getState().saveKey(id, database, { table: tab.table, ...k })}
              onDeleteVirtualKey={(keyId) => useSchema.getState().deleteKey(id, database, keyId)}
              onOpenTable={(t) => openTable(t)}
              onShowInData={(names) => {
                const keep = new Set([...names, ...structure.columns.filter((c) => c.primaryKey).map((c) => c.name)]);
                setHidden(structure.columns.filter((c) => !keep.has(c.name)).map((c) => c.name));
                updateTab(tab.id, { view: 'data' });
              }}
            />
          ) : (
            <CenteredState loading={!structureError} error={structureError} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1">
      <div className="@container relative flex min-w-0 flex-1 flex-col">
        {/* new rows are loading: the old ones stay, a bar under the toolbar says they are about to change */}
        {loading && result && <div className="pointer-events-none absolute inset-x-0 top-11 z-10 h-0.5 animate-pulse bg-accent" data-testid="loading-bar" />}
        <Toolbar>
          <ViewSwitch view="data" onChange={(view) => updateTab(tab.id, { view })} />
          <div className="mx-0.5 h-5 w-px bg-line" />
          {/* the filter area gives way (scrolls) so the buttons on the right always stay reachable */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]">
          <FilterBar
            ref={filterRef}
            usageKey={tableKey}
            engine={session.config.engine}
            columns={filterColumns}
            rules={rules}
            onRulesChange={setRules}
            sort={sort}
            onSortChange={setSort}
            mode={filterMode}
            onModeChange={(m) => {
              setOffset(0);
              updateTab(tab.id, { filterMode: m });
            }}
            sqlText={sqlInput}
            onSqlTextChange={setSqlInput}
            onSqlApply={applySql}
            onSqlClear={clearSql}
            suggestValues={suggestValues}
          />
          </div>
          <div className="flex shrink-0 items-center gap-1">{toolbarEnd}</div>
        </Toolbar>

        {error ? (
          <CenteredState error={error} onRetry={() => load(true)} />
        ) : !result ? (
          <CenteredState loading />
        ) : (
          <DataGrid
            ref={gridRef}
            columns={gridColumns}
            meta={gridMeta}
            rowCount={rowCount}
            getValue={gridGetValue}
            getRowState={getRowState}
            isCellEdited={gridIsCellEdited}
            editable={editable}
            onEdit={(r, c, v) => editCell(r, shownIdx[c], v)}
            onSelectRows={setSelectedRows}
            sort={sort}
            onHeaderClick={onHeaderClick}
            onDeleteRows={editable ? deleteRows : undefined}
            onCellMenu={(row, col, x, y) => setCellMenu({ row, col: shownIdx[col], x, y })}
            onHeaderMenu={(column, x, y) => setHeaderMenu({ column, x, y })}
            onOpenForeignKey={(row, col) => openRelated(row, shownIdx[col])}
          />
        )}

        <BottomBar>
          <button className="btn btn-ghost h-7 gap-1.5 px-2" onClick={addRow} disabled={!editable} title="Add a row" data-testid="add-row">
            <Plus size={14} /> <span className="@max-[720px]:hidden">Add row</span>
          </button>
          <button
            className="btn btn-ghost h-7 gap-1.5 px-2"
            onClick={() => result && exportRows(tab.table, gridColumns, Array.from({ length: loadedCount }, (_, r) => shownIdx.map((c) => getValue(r, c))), toast)}
            disabled={!loadedCount}
            title="Export this page (CSV / JSON)"
          >
            <Download size={13} /> <span className="@max-[720px]:hidden">Export</span>
          </button>
          {editable && validSelected.length > 0 && (
            <>
              <div className="mx-1 h-4 w-px bg-line" />
              <button
                className="btn btn-ghost h-7 gap-1.5 px-2 text-danger hover:!bg-danger-soft hover:!text-danger"
                onClick={() => deleteRows(validSelected)}
                title={`Mark for deletion (${MOD}⌫). Nothing is deleted until you review and save.`}
                data-testid="delete-rows"
              >
                <Trash2 size={13} /> {deleteLabel}
              </button>
            </>
          )}
          {!editable && result && tab.objectKind === 'table' && structure && <span className="ml-1 whitespace-nowrap text-[11.5px] text-ink-3">Read-only · no primary key</span>}
          {tab.objectKind === 'view' && <span className="ml-1 whitespace-nowrap text-[11.5px] text-ink-3">View · read-only</span>}

          {/* the count takes the free middle space and is cut (…) instead of drawing over the buttons */}
          <div className="flex min-w-0 flex-1 justify-center px-2">
          {result && !error && (
            <span className="min-w-0 truncate whitespace-nowrap text-[12px] tabular-nums text-ink-2 @max-[640px]:hidden" data-testid="row-count">
              {total == null ? (
                counting ? (
                  <span className="text-ink-3">
                    Counting rows…{' '}
                    <button className="underline-offset-2 hover:text-ink hover:underline" onClick={cancel} data-testid="cancel-count">
                      Stop
                    </button>
                  </span>
                ) : (
                  <span className="text-ink-3">
                    {formatCount(loadedCount)}
                    {result.truncated ? '+' : ''} rows · not counted
                  </span>
                )
              ) : (
                <>
                  <span className="font-semibold text-ink">{formatCount(total)}</span> {total === 1 ? 'row' : 'rows'}
                  {filter && tableTotal?.key === tableKey && <span className="text-ink-3"> of {formatCount(tableTotal.n)} in table</span>}
                </>
              )}
              {validSelected.length > 0 && <span className="text-ink-3"> · {formatCount(validSelected.length)} selected</span>}
            </span>
          )}
          </div>

          {pending > 0 && (
            <div className="fade-in mr-2 flex shrink-0 items-center gap-1.5" data-testid="pending-bar">
              <span className="mr-1 whitespace-nowrap text-[12px] text-ink-2">
                <span className="font-semibold text-accent">{pending}</span> {pending === 1 ? 'change' : 'changes'}
              </span>
              <button className="icon-btn h-7 w-7" onClick={() => setHistory((h) => undo(h))} title={`Undo (${MOD}Z)`} aria-label="Undo">
                <Undo2 size={14} />
              </button>
              <button className="btn h-7" onClick={discard}>
                Discard
              </button>
              <button className="btn btn-primary h-7" onClick={startSave} data-testid="save">
                Save <span className="opacity-70">{MOD}S</span>
              </button>
            </div>
          )}

          <span className="shrink-0 whitespace-nowrap tabular-nums text-[12px] text-ink-2" data-testid="row-range">
            {loadedCount ? `${formatCount(from)}–${formatCount(to)}` : '0'}
            {total != null ? ` of ${formatCount(total)}` : result?.truncated ? '+' : ''}
          </span>
          <select className="ml-2 h-7 shrink-0 rounded-md border border-line bg-surface px-1.5 text-[12px]" value={limit} onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }} aria-label="Rows per page">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button className="icon-btn h-7 w-7" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0 || loading} aria-label="Previous page">
            <ChevronLeft size={15} />
          </button>
          <button className="icon-btn h-7 w-7" onClick={() => setOffset(offset + limit)} disabled={!result?.truncated || loading} aria-label="Next page">
            <ChevronRight size={15} />
          </button>
        </BottomBar>
      </div>

      {rowPanelOpen && result && (
        <RowPanel
          columns={columns}
          structure={structure}
          row={selectedRow}
          selectedCount={validSelected.length}
          getValue={getValue}
          rowState={selectedRow != null ? getRowState(selectedRow) : null}
          editable={editable}
          engine={session.config.engine}
          onChange={(col, value) => selectedRow != null && editCell(selectedRow, col, value)}
          isEdited={(col) => selectedRow != null && isCellEdited(selectedRow, col)}
          referencedBy={
            selectedRow != null && getRowState(selectedRow) !== 'inserted'
              ? referencing.map((r) => ({ id: r.id, table: r.from, column: r.fromColumns[0], guessed: r.guessed, onOpen: () => openReferencing(selectedRow, r) }))
              : []
          }
          rowLabel={rowLabel}
          pending={pending}
          onSave={startSave}
          onDiscard={discard}
        />
      )}

      {cellMenu && (
        <CellMenu
          x={cellMenu.x}
          y={cellMenu.y}
          column={columns[cellMenu.col].name}
          value={getValue(cellMenu.row, cellMenu.col)}
          row={Object.fromEntries(columns.map((c, i) => [c.name, getValue(cellMenu.row, i)]))}
          editable={editable && getRowState(cellMenu.row) !== 'deleted'}
          foreignKey={meta?.[cellMenu.col]?.foreignKey ?? null}
          onFilter={(rule) => {
            if (filterMode === 'sql') updateTab(tab.id, { filterMode: 'chips' });
            setRules([...rules, rule]);
          }}
          onOpenRelated={(sameTab) => openRelated(cellMenu.row, cellMenu.col, sameTab)}
          referencing={referencing
            .filter((r) => r.toColumns[0] === columns[cellMenu.col].name)
            .map((r) => ({ label: `${r.from}.${r.fromColumns[0]}${r.guessed ? ' (guessed)' : ''}`, onOpen: () => openReferencing(cellMenu.row, r) }))}
          onSetNull={() => editCell(cellMenu.row, cellMenu.col, null)}
          onHideColumn={shownIdx.length > 1 ? () => setHidden([...hidden, columns[cellMenu.col].name]) : undefined}
          onDeleteRow={() => deleteRows([cellMenu.row])}
          onClose={() => setCellMenu(null)}
        />
      )}

      {headerMenu && (
        <HeaderMenu
          x={headerMenu.x}
          y={headerMenu.y}
          column={headerMenu.column}
          canHide={shownIdx.length > 1}
          onHide={() => setHidden([...hidden, headerMenu.column])}
          onOnlyKeys={columnChoices.some((c) => c.key) ? onlyKeys : undefined}
          onShowAll={hidden.length ? () => setHidden([]) : undefined}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {review && (
        <ReviewDialog
          statements={review}
          environment={session.config.environment}
          connectionName={session.config.name}
          database={session.config.engine === 'mysql' ? database : session.info.currentDatabase}
          busy={saving} onApply={applySave} onClose={() => setReview(null)} />
      )}
    </div>
  );
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2.5">{children}</div>;
}

function BottomBar({ children }: { children: React.ReactNode }) {
  return <div className="relative flex h-10 shrink-0 items-center gap-1 overflow-hidden border-t border-line bg-bg px-2">{children}</div>;
}

function ViewSwitch({ view, onChange }: { view: 'data' | 'structure'; onChange: (v: 'data' | 'structure') => void }) {
  return (
    <div className="flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="View">
      {(['data', 'structure'] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={cx('h-6 rounded-md px-3 text-[12px] font-medium capitalize', view === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
          onClick={() => onChange(v)}
          data-testid={`view-${v}`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

export function CenteredState({ loading, error, onRetry }: { loading?: boolean; error?: string | null; onRetry?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      {error ? (
        <div className="max-w-xl rounded-xl border border-line bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
          <div className="selectable mono break-words">{error}</div>
          {onRetry && (
            <button className="btn mt-3 h-7" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      ) : loading ? (
        <Loader2 size={18} className="animate-spin text-ink-3" />
      ) : null}
    </div>
  );
}
