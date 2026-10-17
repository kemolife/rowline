import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, History as HistoryIcon, Loader2, Sparkles } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { EXPORT_FORMATS, exportRows, forClaude, formatRows, guessTable, type ExportFormat } from '../lib/export';
import type { Engine, QueryResult } from '../lib/types';
import { cx, formatCount } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useApp } from '../store/app';
import { CenteredState } from './DataTab';
import DataGrid from './DataGrid';

/** One run of the editor: what ran and everything it returned. Kept in memory while the tab is open. */
export interface Run {
  id: number;
  sql: string;
  startedAt: number;
  elapsedMs: number;
  results: QueryResult[];
  error: string | null;
  /** result set shown (a run of several statements has several) */
  current: number;
}

export const MAX_RUNS = 30;

type View = 'grid' | 'fields' | 'json' | 'text';
/** records shown side by side in the Fields view */
const FIELDS_ROWS = 100;

const firstLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export default function ResultPanel({
  runs,
  index,
  onIndex,
  onResultIndex,
  running,
  engine,
  name,
  onAskClaude,
}: {
  runs: Run[];
  index: number;
  onIndex: (i: number) => void;
  onResultIndex: (runIndex: number, resultIndex: number) => void;
  running: boolean;
  engine: Engine;
  /** file name base for exports */
  name: string;
  onAskClaude: (text: string) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [view, setView] = useState<View>('grid');
  const [menu, setMenu] = useState<'runs' | 'copy' | 'export' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);

  const run = runs[index];
  const result = run?.results[run.current];
  const hasRows = !!result && result.columns.length > 0;
  const table = guessTable(result?.statement ?? run?.sql ?? null);

  const text = useMemo(() => {
    if (!result || !hasRows || view === 'grid' || view === 'fields') return '';
    return view === 'json' ? formatRows('json', result.columns, result.rows, table, engine) : formatRows('text', result.columns, result.rows, table, engine);
  }, [result, hasRows, view, table, engine]);

  const copy = async (label: string, value: string) => {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast('Could not copy to the clipboard.', 'error');
    }
  };

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3';

  if (!run) {
    return running ? <CenteredState loading /> : <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-3">Results appear here. Every run is kept, so you can go back to it without running the query again.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="result-panel">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2" ref={menuRef}>
        {/* runs of this tab */}
        <div className="flex items-center">
          <button className="icon-btn h-6 w-6" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous run" title="Previous run">
            <ChevronLeft size={14} />
          </button>
          <div className="relative">
            <button className={cx('flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface-2', menu === 'runs' && 'bg-surface-2')} onClick={() => setMenu(menu === 'runs' ? null : 'runs')} data-testid="runs-button" title="All runs of this tab">
              <HistoryIcon size={12} /> Run {index + 1} of {runs.length}
              <ChevronDown size={11} />
            </button>
            {menu === 'runs' && (
              <div className="fade-in absolute left-0 top-7 z-30 max-h-80 w-[560px] overflow-y-auto rounded-xl border border-line-strong bg-surface-2 p-1 text-[12px] shadow-[var(--shadow)]" data-testid="runs-menu">
                {runs
                  .map((r, i) => ({ r, i }))
                  .reverse()
                  .map(({ r, i }) => {
                    const rows = r.results.filter((x) => x.columns.length).reduce((n, x) => n + x.rows.length, 0);
                    return (
                      <button
                        key={r.id}
                        className={cx('flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-3', i === index && 'bg-surface-3')}
                        onClick={() => {
                          onIndex(i);
                          setMenu(null);
                        }}
                      >
                        <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', r.error ? 'bg-danger' : 'bg-success')} />
                        <span className="shrink-0 tabular-nums text-ink-3">#{i + 1}</span>
                        <span className="mono line-clamp-2 min-w-0 flex-1 text-[11.5px] text-ink">{firstLine(r.sql)}</span>
                        <span className="shrink-0 whitespace-nowrap tabular-nums text-[11px] text-ink-3">
                          {r.error ? 'error' : `${formatCount(rows)} rows`} · {r.elapsedMs} ms · {new Date(r.startedAt).toLocaleTimeString()}
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
          <button className="icon-btn h-6 w-6" onClick={() => onIndex(index + 1)} disabled={index >= runs.length - 1} aria-label="Next run" title="Next run">
            <ChevronRight size={14} />
          </button>
        </div>

        {run.results.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {run.results.map((r, i) => (
              <button
                key={i}
                className={cx('h-6 shrink-0 rounded-md px-2 text-[12px]', i === run.current ? 'bg-sel font-medium text-link' : 'text-ink-2 hover:bg-surface-2')}
                onClick={() => onResultIndex(index, i)}
                title={r.statement ?? undefined}
              >
                {r.columns.length ? `Result ${i + 1}` : `Statement ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {hasRows && (
          <>
            <div className="flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Result view">
              {(['grid', 'fields', 'json', 'text'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={cx('h-5 rounded-md px-2 text-[11.5px] font-medium', view === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
                  onClick={() => setView(v)}
                  data-testid={`result-view-${v}`}
                >
                  {v === 'grid' ? 'Grid' : v === 'fields' ? 'Fields' : v === 'json' ? 'JSON' : 'Text'}
                </button>
              ))}
            </div>
            <div className="relative">
              <button className={cx('btn btn-ghost h-7 gap-1 px-2', menu === 'copy' && 'bg-surface-2')} onClick={() => setMenu(menu === 'copy' ? null : 'copy')} data-testid="copy-result">
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'} <ChevronDown size={11} />
              </button>
              {menu === 'copy' && (
                <div className="fade-in absolute right-0 top-8 z-30 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
                  <button className={item} onClick={() => copy('Claude', forClaude(result.statement ?? run.sql, result.columns, result.rows))} data-testid="copy-for-claude">
                    <Sparkles size={13} className="text-accent" /> Copy for Claude
                  </button>
                  <div className="my-1 h-px bg-line" />
                  {EXPORT_FORMATS.map((f) => (
                    <button key={f.format} className={item} onClick={() => copy(f.label, formatRows(f.format, result.columns, result.rows, table, engine))}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <button className={cx('btn btn-ghost h-7 gap-1 px-2', menu === 'export' && 'bg-surface-2')} onClick={() => setMenu(menu === 'export' ? null : 'export')} data-testid="export-result">
                <Download size={13} /> Export <ChevronDown size={11} />
              </button>
              {menu === 'export' && (
                <div className="fade-in absolute right-0 top-8 z-30 w-52 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
                  {EXPORT_FORMATS.map((f) => (
                    <button
                      key={f.format}
                      className={item}
                      onClick={() => {
                        setMenu(null);
                        exportRows(name, result.columns, result.rows, toast, { format: f.format as ExportFormat, table, engine });
                      }}
                    >
                      {f.label} <span className="ml-auto text-[11px] text-ink-3">.{f.ext}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="btn btn-ghost h-7 gap-1.5 px-2"
              onClick={() => onAskClaude(`${forClaude(result.statement ?? run.sql, result.columns, result.rows)}\n`)}
              title="Open the Claude panel with this query and result in the message"
              data-testid="ask-claude-result"
            >
              <Sparkles size={13} className="text-accent" /> Ask Claude
            </button>
          </>
        )}
        {result && (
          <span className="shrink-0 pl-1 text-[12px] tabular-nums text-ink-2" data-testid="result-status">
            {result.columns.length ? `${formatCount(result.rows.length)}${result.truncated ? '+' : ''} rows` : `${formatCount(result.affectedRows ?? 0)} affected`} · {result.elapsedMs} ms
          </span>
        )}
      </div>

      {run.error ? (
        <CenteredState error={run.error} />
      ) : !result ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-3">No result.</div>
      ) : !hasRows ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-[13px]">
          <div className="font-medium">{formatCount(result.affectedRows ?? 0)} rows affected</div>
          <div className="mono max-w-xl truncate text-[11.5px] text-ink-3">{result.statement}</div>
        </div>
      ) : (
        <>
          {result.truncated && (
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-1.5 text-[12px] text-ink-2">
              <AlertTriangle size={13} className="text-warning" /> Showing the first {formatCount(result.rows.length)} rows (row limit). Raise the limit or add a LIMIT to see others.
            </div>
          )}
          {view === 'grid' ? (
            <DataGrid key={`${run.id}-${run.current}`} columns={result.columns} rowCount={result.rows.length} getValue={(r, c) => result.rows[r][c]} />
          ) : view === 'fields' ? (
            // transposed: one line per column, the records side by side (good for wide tables)
            <DataGrid
              key={`f-${run.id}-${run.current}`}
              columns={[{ name: 'field', typeName: 'text' }, ...result.rows.slice(0, FIELDS_ROWS).map((_, i) => ({ name: `#${i + 1}`, typeName: '' }))]}
              rowCount={result.columns.length}
              getValue={(r, c) => (c === 0 ? result.columns[r].name : result.rows[c - 1][r])}
            />
          ) : (
            <pre className="selectable mono min-h-0 flex-1 overflow-auto whitespace-pre p-3 text-[12px] leading-relaxed text-ink" data-testid="result-text">
              {text}
            </pre>
          )}
        </>
      )}
      {running && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-3 text-[12px] text-ink-3">
          <Loader2 size={12} className="animate-spin" /> Running… the result is added as a new run.
        </div>
      )}
    </div>
  );
}
