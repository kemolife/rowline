import { ArrowDown, ArrowUp, Code2, Filter, Plus, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FilterColumn } from '../lib/filterComplete';
import { FILTER_OPS, NO_VALUE_OPS, RAW_SQL, enumValues, newRule, ruleLabel, type FilterOp, type FilterRule } from '../lib/filters';
import type { Engine, SortSpec } from '../lib/types';
import { MOD, cx } from '../lib/ui';
import { useDismiss, type DismissReason } from '../lib/useDismiss';
import FilterInput, { type FilterInputHandle } from './FilterInput';

export type FilterMode = 'chips' | 'sql';

export interface FilterBarHandle {
  /** chips: opens "+ Filter"; SQL: focuses the WHERE box */
  focus: () => void;
}

interface Props {
  engine: Engine;
  columns: FilterColumn[];
  rules: FilterRule[];
  onRulesChange: (rules: FilterRule[]) => void;
  sort: SortSpec[];
  onSortChange: (sort: SortSpec[]) => void;
  mode: FilterMode;
  onModeChange: (mode: FilterMode) => void;
  sqlText: string;
  onSqlTextChange: (text: string) => void;
  onSqlApply: () => void;
  onSqlClear: () => void;
  /** common values of a column, for the value field */
  suggestValues?: (column: string) => Promise<string[]>;
}

type Popover = { kind: 'rule'; ruleId: string | null; x: number; y: number } | { kind: 'sort'; x: number; y: number };

const anchor = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 6 };
};

/**
 * Filters of a table tab: chips (column / operator / value, no SQL needed) and a sort chip,
 * or the raw SQL WHERE box. Chips apply as soon as they are added or changed.
 */
const FilterBar = forwardRef<FilterBarHandle, Props>(function FilterBar(props, ref) {
  const { engine, columns, rules, onRulesChange, sort, onSortChange, mode, onModeChange, sqlText, onSqlTextChange, onSqlApply, onSqlClear, suggestValues } = props;
  const [popover, setPopover] = useState<Popover | null>(null);
  /**
   * Unfinished filters (key: rule id, or "new"): closing the editor by clicking elsewhere keeps what was typed,
   * so you can copy a value from the grid or another app and continue. Apply, Remove and Esc drop it.
   */
  const [drafts, setDrafts] = useState<Record<string, FilterRule>>({});
  const dropDraft = (key: string) => setDrafts(({ [key]: _gone, ...rest }) => rest);
  const addRef = useRef<HTMLButtonElement>(null);
  const sqlRef = useRef<FilterInputHandle>(null);
  const close = useCallback(() => setPopover(null), []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (mode === 'sql') sqlRef.current?.focus();
      else if (addRef.current) setPopover({ kind: 'rule', ruleId: null, ...anchor(addRef.current) });
    },
  }));

  const quoteName = (s: string) => (engine === 'mysql' ? `\`${s}\`` : `"${s}"`);
  const sortSpec = sort[0];

  return (
    <div className="flex min-w-[150px] flex-1 items-center gap-1.5" data-testid="filter-bar">
      {mode === 'sql' ? (
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-lg border border-line bg-surface focus-within:border-sel-strong focus-within:shadow-[0_0_0_3px_var(--sel)]">
          <span className="mono pl-2.5 pr-1.5 text-[11.5px] font-semibold text-link">WHERE</span>
          <FilterInput
            ref={sqlRef}
            value={sqlText}
            onChange={onSqlTextChange}
            onSubmit={onSqlApply}
            onClear={onSqlClear}
            columns={columns}
            engine={engine}
            placeholder={`e.g. ${quoteName(columns[1]?.name ?? 'id')} LIKE '%abc%'`}
          />
          {sqlText ? (
            <button className="icon-btn mr-0.5 h-6 w-6" onClick={onSqlClear} aria-label="Clear filter" title="Clear filter">
              <X size={13} />
            </button>
          ) : (
            <span className="mr-2 shrink-0 text-[11px] text-ink-3">↵ to apply</span>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
          {rules.map((r) => {
            const l = ruleLabel(r);
            return (
              <div
                key={r.id}
                className={cx('flex h-6 shrink-0 items-center rounded-md text-[12px]', r.enabled ? 'bg-sel text-link' : 'bg-surface-2 text-ink-3 line-through')}
                data-testid="filter-chip"
              >
                <button
                  className="flex h-full max-w-[320px] items-center gap-1.5 truncate pl-2.5 pr-1"
                  onClick={(e) => setPopover({ kind: 'rule', ruleId: r.id, ...anchor(e.currentTarget) })}
                  title="Edit filter"
                >
                  <span className="mono">{l.column}</span>
                  {l.op && <span className="opacity-70">{l.op}</span>}
                  {l.value && <span className="mono truncate font-semibold">{l.value}</span>}
                </button>
                <button className="flex h-full items-center px-1.5 opacity-60 hover:opacity-100" onClick={() => onRulesChange(rules.filter((x) => x.id !== r.id))} aria-label="Remove filter" title="Remove filter">
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            ref={addRef}
            className={cx(
              'flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed px-2 text-[12px] hover:bg-surface-2',
              drafts.new ? 'border-sel-strong text-link' : 'border-line-strong text-ink-2',
            )}
            onClick={(e) => setPopover({ kind: 'rule', ruleId: null, ...anchor(e.currentTarget) })}
            title={drafts.new ? 'Continue the unfinished filter' : `Add a filter (${MOD}F)`}
            data-testid="add-filter"
          >
            <Plus size={12} /> Filter
            {drafts.new && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-sel-strong" data-testid="filter-draft-dot" />}
          </button>
          <button
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3"
            onClick={(e) => setPopover({ kind: 'sort', ...anchor(e.currentTarget) })}
            title="Sort (or click a column header)"
            data-testid="sort-chip"
          >
            <span className="text-ink-3">Sort</span>
            {sortSpec ? (
              <>
                <span className="mono">{sortSpec.column}</span>
                {sortSpec.descending ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
              </>
            ) : (
              <span className="text-ink-3">none</span>
            )}
          </button>
        </div>
      )}

      <button
        className={cx('btn btn-ghost h-7 gap-1.5 px-2', mode === 'sql' && 'bg-surface-2 text-ink')}
        onClick={() => onModeChange(mode === 'sql' ? 'chips' : 'sql')}
        title={mode === 'sql' ? 'Back to filter chips' : 'Write the WHERE clause in SQL'}
        data-testid="filter-mode"
      >
        {mode === 'sql' ? <Filter size={13} /> : <Code2 size={13} />} {mode === 'sql' ? 'Filters' : 'SQL'}
      </button>

      {popover?.kind === 'rule' && (
        <RuleEditor
          key={popover.ruleId ?? 'new'}
          x={popover.x}
          y={popover.y}
          columns={columns}
          rule={rules.find((r) => r.id === popover.ruleId) ?? null}
          draft={drafts[popover.ruleId ?? 'new']}
          onDraftChange={(d) => setDrafts((all) => ({ ...all, [popover.ruleId ?? 'new']: d }))}
          suggestValues={suggestValues}
          onSave={(rule) => {
            onRulesChange(popover.ruleId ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
            dropDraft(popover.ruleId ?? 'new');
            close();
          }}
          onRemove={popover.ruleId ? () => (onRulesChange(rules.filter((r) => r.id !== popover.ruleId)), dropDraft(popover.ruleId!), close()) : undefined}
          onClose={(reason) => {
            if (reason === 'escape') dropDraft(popover.ruleId ?? 'new');
            close();
          }}
        />
      )}
      {popover?.kind === 'sort' && (
        <SortEditor
          x={popover.x}
          y={popover.y}
          columns={columns}
          sort={sortSpec ?? null}
          onSave={(s) => {
            onSortChange(s ? [s] : []);
            close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
});

export default FilterBar;

function Floating({ x, y, onClose, children, width = 380 }: { x: number; y: number; onClose: (reason: DismissReason) => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // a form: stays open while you switch to another app (to copy a value)
  useDismiss(ref, onClose, true, false);
  return createPortal(
    <div
      ref={ref}
      className="fade-in fixed z-50 rounded-xl border border-line-strong bg-surface p-3 text-[12.5px] shadow-[var(--shadow)]"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: y, width }}
    >
      {children}
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}

function RuleEditor({
  x,
  y,
  columns,
  rule,
  draft: saved,
  onDraftChange,
  onSave,
  onRemove,
  onClose,
  suggestValues,
}: {
  x: number;
  y: number;
  columns: FilterColumn[];
  rule: FilterRule | null;
  /** what was typed last time and not applied */
  draft?: FilterRule;
  onDraftChange: (d: FilterRule) => void;
  onSave: (r: FilterRule) => void;
  onRemove?: () => void;
  onClose: (reason: DismissReason) => void;
  suggestValues?: (column: string) => Promise<string[]>;
}) {
  const [draft, setDraft] = useState<FilterRule>(() => saved ?? rule ?? newRule(columns[0]?.name ?? RAW_SQL));
  // values to pick from: ENUM values from the type, else the most common values in the table
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    setSuggestions([]);
    if (draft.column === RAW_SQL) return;
    const fromType = enumValues(columns.find((c) => c.name === draft.column)?.type ?? '');
    if (fromType) {
      setSuggestions(fromType);
      return;
    }
    let cancelled = false;
    suggestValues?.(draft.column)
      .then((v) => !cancelled && setSuggestions(v))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draft.column, columns, suggestValues]);
  const listId = `values-${draft.id}`;
  const raw = draft.column === RAW_SQL;
  const needsValue = !raw && !NO_VALUE_OPS.includes(draft.op);
  const set = (patch: Partial<FilterRule>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraftChange(next);
  };
  const save = () => onSave({ ...draft, enabled: draft.enabled });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  };
  const valuePlaceholder = draft.op === 'IN' || draft.op === 'NOT IN' ? 'a, b, c' : draft.op === 'LIKE' || draft.op === 'NOT LIKE' ? '%abc%' : 'value';

  return (
    <Floating x={x} y={y} onClose={onClose}>
      <div className="space-y-2" data-testid="rule-editor">
        <div className="flex gap-2">
          <select className="field h-8 min-w-0 flex-1 text-[12.5px]" value={draft.column} onChange={(e) => set({ column: e.target.value })} aria-label="Column" autoFocus>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
            <option value={RAW_SQL}>Raw SQL…</option>
          </select>
          {!raw && (
            <select className="field h-8 w-[130px] text-[12.5px]" value={draft.op} onChange={(e) => set({ op: e.target.value as FilterOp })} aria-label="Operator">
              {FILTER_OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
        </div>
        {raw ? (
          <textarea
            className="field field-mono h-16 resize-none py-1.5"
            value={draft.value}
            placeholder="`price` > 10 OR `price` IS NULL"
            onChange={(e) => set({ value: e.target.value })}
            onKeyDown={onKey}
            aria-label="SQL condition"
          />
        ) : (
          needsValue && (
            <div className="flex items-center gap-2">
              <input
                className="field field-mono h-8"
                value={draft.value}
                placeholder={suggestions.length ? `${valuePlaceholder} — or pick from the list` : valuePlaceholder}
                onChange={(e) => set({ value: e.target.value })}
                onKeyDown={onKey}
                aria-label="Value"
                list={suggestions.length ? listId : undefined}
                autoFocus={!!rule}
              />
              <datalist id={listId}>
                {suggestions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              {draft.op === 'BETWEEN' && (
                <>
                  <span className="text-ink-3">and</span>
                  <input className="field field-mono h-8" value={draft.value2 ?? ''} onChange={(e) => set({ value2: e.target.value })} onKeyDown={onKey} aria-label="Second value" />
                </>
              )}
            </div>
          )
        )}
        <div className="flex items-center gap-2 pt-1">
          <label className="flex items-center gap-1.5 text-ink-2">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Active
          </label>
          <div className="flex-1" />
          {onRemove && (
            <button className="btn btn-ghost h-7 text-danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <button className="btn btn-primary h-7" onClick={save} data-testid="apply-rule">
            Apply <span className="opacity-70">↵</span>
          </button>
        </div>
      </div>
    </Floating>
  );
}

function SortEditor({ x, y, columns, sort, onSave, onClose }: { x: number; y: number; columns: FilterColumn[]; sort: SortSpec | null; onSave: (s: SortSpec | null) => void; onClose: () => void }) {
  const [column, setColumn] = useState(sort?.column ?? '');
  const [descending, setDescending] = useState(sort?.descending ?? false);
  return (
    <Floating x={x} y={y} onClose={onClose} width={320}>
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Order by</div>
        <div className="flex gap-2">
          <select className="field h-8 min-w-0 flex-1 text-[12.5px]" value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Sort column" autoFocus>
            <option value="">No sorting</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="field h-8 w-[96px] text-[12.5px]" value={descending ? 'desc' : 'asc'} onChange={(e) => setDescending(e.target.value === 'desc')} disabled={!column} aria-label="Direction">
            <option value="asc">ASC ↑</option>
            <option value="desc">DESC ↓</option>
          </select>
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary h-7" onClick={() => onSave(column ? { column, descending } : null)}>
            Apply
          </button>
        </div>
      </div>
    </Floating>
  );
}
