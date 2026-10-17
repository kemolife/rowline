import { MySQL, SQLite, sql as sqlLang } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { ChevronDown, FileDown, History as HistoryIcon, Play, PlayCircle, Save, Square, WandSparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format as formatSql } from 'sql-formatter';
import { api, confirmDialog, pickSavePath } from '../lib/api';
import { setStatements, statementGutter, statementsField, toEditorStatements } from '../lib/statementGutter';
import { joinSuggestions, lintStatement, tableRefs, updatesAllRows } from '../lib/sqlAssist';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import { useRelations } from '../store/schema';
import type { HistoryEntry } from '../lib/types';
import { MOD, cx, matchKey } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useApp, type QueryTab } from '../store/app';
import { useChat } from '../store/chat';
import { useQueries } from '../store/queries';
import { useWs, useWsActions } from '../store/workspace';
import ResultPanel, { MAX_RUNS, type Run } from './ResultPanel';
import SaveQueryDialog from './SaveQueryDialog';

/** Rows fetched per statement; the database still runs the whole query */
const ROW_LIMITS: { value: number; label: string }[] = [
  { value: 100, label: '100 rows' },
  { value: 1000, label: '1,000 rows' },
  { value: 5000, label: '5,000 rows' },
  { value: 50000, label: '50,000 rows' },
  { value: 0, label: 'No limit' },
];
const NO_LIMIT = 10_000_000;
let runSeq = 0;

export default function QueryTabView({ tab, active }: { tab: QueryTab; active: boolean }) {
  const session = useWs((w) => w.session);
  const { updateTab, refreshObjects } = useWsActions();
  const toast = useApp((s) => s.toast);
  const themeMode = useApp((s) => s.theme);
  const id = session.connectionId;
  const database = session.config.engine === 'mysql' ? session.database : null;

  const [sql, setSql] = useState(tab.sql);
  const [running, setRunning] = useState(false);
  // every run of this tab, so an earlier result can be shown again without running the query again
  const [runs, setRuns] = useState<Run[]>([]);
  const [runIndex, setRunIndex] = useState(0);
  const [runMenu, setRunMenu] = useState(false);
  const runMenuRef = useRef<HTMLDivElement>(null);
  const closeRunMenu = useCallback(() => setRunMenu(false), []);
  useDismiss(runMenuRef, closeRunMenu, runMenu);
  const maxRows = tab.maxRows ?? 5000;
  // relations for JOIN completion: read once the tab is opened (cached per database)
  const relations = useRelations(id, database, active);
  const assist = useRef({ relations, schema: new Map<string, Set<string>>() });
  assist.current.relations = relations;
  const [editorHeight, setEditorHeight] = useState(45); // percent
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  /** name dialog for a new saved query (or "save as") */
  const [saveDialog, setSaveDialog] = useState<{ name: string } | null>(null);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // keep tab state in sync (debounced) so it survives tab switches
  useEffect(() => {
    const t = setTimeout(() => updateTab(tab.id, { sql }), 300);
    return () => clearTimeout(t);
  }, [sql, tab.id, updateTab]);

  useEffect(() => {
    api.schemaColumns(id, database).then(setSchema).catch(() => setSchema({}));
  }, [id, database]);
  // table → columns (lower case) for the warnings
  useEffect(() => {
    assist.current.schema = new Map(Object.entries(schema).map(([t, cols]) => [t.toLowerCase(), new Set(cols.map((c) => c.toLowerCase()))]));
  }, [schema]);

  useEffect(() => {
    if (active) setTimeout(() => editorRef.current?.view?.focus(), 0);
  }, [active]);

  const isDark = useMemo(() => {
    if (themeMode !== 'system') return themeMode === 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }, [themeMode]);

  /** Runs this SQL and adds the result as a new run */
  const runText = useCallback(
    async (text: string) => {
      if (running || !text.trim()) return;
      // UPDATE / DELETE without WHERE: changes every row, ask first
      const allRows = (await api.splitStatements(text)).map((p) => p.text).filter(updatesAllRows);
      if (allRows.length && !(await confirmDialog(`This changes EVERY row (no WHERE):\n\n${allRows.map((t) => t.slice(0, 200)).join('\n\n')}\n\nRun it?`, { title: 'No WHERE', danger: true }))) return;
      if (session.config.environment === 'prod' && !(await api.isReadOnly(text))) {
        if (!(await confirmDialog('This is a PRODUCTION connection and the SQL changes data or schema.\n\nRun it?', { title: 'Production', danger: true }))) return;
      }
      setRunning(true);
      const startedAt = Date.now();
      let entry: Run;
      try {
        const res = await api.executeSql(id, database, text, maxRows || NO_LIMIT);
        entry = { id: ++runSeq, sql: text, startedAt, elapsedMs: Date.now() - startedAt, results: res, error: null, current: Math.max(0, res.findIndex((r) => r.columns.length > 0)) };
        if (res.some((r) => r.affectedRows != null && r.columns.length === 0)) refreshObjects();
      } catch (e) {
        entry = { id: ++runSeq, sql: text, startedAt, elapsedMs: Date.now() - startedAt, results: [], error: (e as Error).message, current: 0 };
      }
      setRuns((rs) => {
        const next = [...rs, entry].slice(-MAX_RUNS);
        setRunIndex(next.length - 1);
        return next;
      });
      setRunning(false);
    },
    [running, session.config.environment, id, database, maxRows, refreshObjects],
  );

  const run = useCallback(
    async (mode: 'current' | 'all' | 'selection') => {
      const view = editorRef.current?.view;
      if (!view) return;
      const doc = view.state.doc.toString();
      const sel = view.state.selection.main;
      let text = doc;
      if (sel.from !== sel.to) text = doc.slice(sel.from, sel.to);
      else if (mode === 'selection') return;
      else if (mode === 'current') {
        const parts = await api.splitStatements(doc);
        // character offsets from the backend; CodeMirror uses UTF-16 offsets
        const cursorChars = [...doc.slice(0, sel.head)].length;
        const hit = parts.find((p) => cursorChars >= p.start && cursorChars <= p.end + 1) ?? [...parts].reverse().find((p) => p.start <= cursorChars) ?? parts[0];
        text = hit?.text ?? '';
      }
      await runText(text);
    },
    [runText],
  );

  /** Formats the selection, or the whole editor */
  const beautify = useCallback(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    const from = sel.from !== sel.to ? sel.from : 0;
    const to = sel.from !== sel.to ? sel.to : view.state.doc.length;
    try {
      const pretty = formatSql(view.state.sliceDoc(from, to), { language: session.config.engine === 'mysql' ? 'mysql' : 'sqlite', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 });
      view.dispatch({ changes: { from, to, insert: pretty } });
    } catch (e) {
      toast(`Could not format: ${(e as Error).message}`, 'error');
    }
  }, [session.config.engine, toast]);
  const beautifyRef = useRef(beautify);
  beautifyRef.current = beautify;

  const saveSqlFile = async () => {
    setRunMenu(false);
    const path = await pickSavePath(`${tab.title.replace(/[^\w.-]+/g, '_')}.sql`, 'sql', true);
    if (!path) return;
    try {
      await api.writeTextFile(path, editorRef.current?.view?.state.doc.toString() ?? sql);
      toast(`Saved ${path.split('/').pop()}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const cancel = useCallback(async () => {
    try {
      await api.cancelQuery(id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [id, toast]);

  const runRef = useRef(run);
  runRef.current = run;
  const runTextRef = useRef(runText);
  runTextRef.current = runText;

  // statements for the ▶ markers: split by the backend (same rules as running), a moment after typing stops
  useEffect(() => {
    const t = setTimeout(() => {
      const view = editorRef.current?.view;
      if (!view) return;
      const doc = view.state.doc.toString();
      api
        .splitStatements(doc)
        .then((ranges) => {
          const v = editorRef.current?.view;
          if (v && v.state.doc.toString() === doc) v.dispatch({ effects: setStatements.of(toEditorStatements(doc, ranges)) });
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [sql]);

  useEffect(() => {
    if (!tab.autoRun) return;
    updateTab(tab.id, { autoRun: false });
    setTimeout(() => runRef.current('all'), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  // ⌘S updates the saved query this tab shows, or asks for a name; ⌘⇧S always asks (save as)
  const saveQuery = async (asNew = false) => {
    const text = editorRef.current?.view?.state.doc.toString() ?? sql;
    if (!text.trim()) {
      toast('Write a query first.', 'info');
      return;
    }
    if (tab.savedQueryId && !asNew) {
      const saved = await useQueries.getState().save({ id: tab.savedQueryId, connectionId: id, name: tab.title, sql: text, database });
      if (saved) toast(`Saved "${saved.name}"`, 'success');
      return;
    }
    setSaveDialog({ name: tab.savedQueryId ? `${tab.title} copy` : '' });
  };
  const saveRef = useRef(saveQuery);
  saveRef.current = saveQuery;

  const saveAs = async (name: string) => {
    const text = editorRef.current?.view?.state.doc.toString() ?? sql;
    const saved = await useQueries.getState().save({ connectionId: id, name, sql: text, database });
    if (!saved) return;
    setSaveDialog(null);
    updateTab(tab.id, { title: saved.name, savedQueryId: saved.id, sql: text });
    toast(`Saved "${saved.name}" to Queries`, 'success');
  };

  // ⌘S while the editor is not focused (the editor's own keymap handles it when it is)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (matchKey(e, 'mod+s') || matchKey(e, 'mod+shift+s')) {
        e.preventDefault();
        saveRef.current(e.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const extensions = useMemo(
    () => [
      sqlLang({ dialect: session.config.engine === 'mysql' ? MySQL : SQLite, schema, upperCaseKeywords: true }),
      EditorView.lineWrapping,
      statementGutter((stmt) => runTextRef.current(stmt.text)),
      // JOIN completion: `JOIN ` offers tables related to the ones already in the statement, with the ON part
      (session.config.engine === 'mysql' ? MySQL : SQLite).language.data.of({
        autocomplete: (ctx: CompletionContext) => {
          const m = ctx.matchBefore(/\bjoin\s+[\w$]*$/i);
          if (!m) return null;
          const word = /[\w$]*$/.exec(m.text)![0];
          const stmt = ctx.state.field(statementsField).find((s) => ctx.pos >= s.from && ctx.pos <= s.to + 1);
          const text = stmt ? ctx.state.sliceDoc(stmt.from, ctx.pos) : ctx.state.sliceDoc(0, ctx.pos);
          const options: Completion[] = joinSuggestions(tableRefs(text), assist.current.relations).map((j, i) => ({
            label: j.text,
            detail: j.detail,
            type: 'class',
            boost: 99 - i,
          }));
          return options.length ? { from: ctx.pos - word.length, options, filter: true } : null;
        },
      }),
      // warnings: UPDATE / DELETE without WHERE, unknown tables and columns
      lintGutter(),
      linter(
        (view) => {
          const out: Diagnostic[] = [];
          for (const s of view.state.field(statementsField)) {
            const text = view.state.sliceDoc(s.from, s.to);
            for (const i of lintStatement(text, assist.current.schema)) out.push({ from: s.from + i.from, to: s.from + i.to, severity: i.severity, message: i.message });
          }
          return out;
        },
        { delay: 500, needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setStatements))) },
      ),
      Prec.highest(
        keymap.of([
          { key: 'Mod-i', run: () => (beautifyRef.current(), true) },
          { key: 'Mod-Enter', run: () => (runRef.current('current'), true) },
          { key: 'Shift-Mod-Enter', run: () => (runRef.current('all'), true) },
          { key: 'Mod-.', run: () => (cancelRef.current(), true) },
          { key: 'Mod-s', run: () => (saveRef.current(false), true) },
          { key: 'Shift-Mod-s', run: () => (saveRef.current(true), true) },
        ]),
      ),
    ],
    [session.config.engine, schema],
  );

  const openHistory = async () => {
    setHistoryOpen(!historyOpen);
    if (!historyOpen) setHistory(await api.listHistory(id).catch(() => []));
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setEditorHeight(Math.min(85, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 flex-col">
      <div className="relative min-h-0" style={{ height: `${editorHeight}%` }} data-testid="sql-editor">
        <CodeMirror
          ref={editorRef}
          value={sql}
          height="100%"
          className="h-full"
          theme={isDark ? 'dark' : 'light'}
          extensions={extensions}
          onChange={setSql}
          placeholder={`SELECT * FROM … — ${MOD}↵ runs the statement at the cursor`}
          basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, autocompletion: true }}
        />
      </div>

      <div className="flex h-10 shrink-0 cursor-row-resize items-center gap-1.5 border-y border-line bg-bg px-2" onMouseDown={(e) => e.target === e.currentTarget && startResize(e)}>
        {running ? (
          <button className="btn h-7" onClick={cancel} data-testid="cancel-query">
            <Square size={12} className="fill-current" /> Cancel <span className="text-ink-3">{MOD}.</span>
          </button>
        ) : (
          <div className="relative flex" ref={runMenuRef}>
            <button className="btn btn-primary h-7 rounded-r-none" onClick={() => run('current')} data-testid="run-current" title={`Run the statement at the cursor, or the selection (${MOD}↵)`}>
              <Play size={13} className="fill-current" /> Run <span className="opacity-70">{MOD}↵</span>
            </button>
            <button className="btn btn-primary h-7 rounded-l-none border-l-[color-mix(in_srgb,var(--accent-text)_25%,transparent)] px-1.5" onClick={() => setRunMenu(!runMenu)} aria-label="More run options" data-testid="run-menu">
              <ChevronDown size={13} />
            </button>
            {runMenu && (
              <div className="fade-in absolute left-0 top-8 z-30 w-60 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
                {(
                  [
                    ['Run current statement', `${MOD}↵`, () => run('current')],
                    ['Run all', `⇧${MOD}↵`, () => run('all')],
                    ['Run selection', '', () => run('selection')],
                    null,
                    ['Save to Queries', `${MOD}S`, () => saveQuery(false)],
                    ['Save to Queries as copy…', `⇧${MOD}S`, () => saveQuery(true)],
                    ['Save SQL file…', '', saveSqlFile],
                  ] as const
                ).map((it, i) =>
                  it === null ? (
                    <div key={i} className="my-1 h-px bg-line" />
                  ) : (
                    <button
                      key={it[0]}
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3"
                      onClick={() => {
                        setRunMenu(false);
                        it[2]();
                      }}
                    >
                      {it[0]} <span className="ml-auto text-[11px] text-ink-3">{it[1]}</span>
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {!running && (
          <button className="btn h-7" onClick={() => run('all')} title={`Run all statements, each with its own result (⇧${MOD}↵)`}>
            <PlayCircle size={14} /> Run all
          </button>
        )}
        <select
          className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink-2"
          value={maxRows}
          onChange={(e) => updateTab(tab.id, { maxRows: Number(e.target.value) })}
          title="How many rows to fetch per statement"
          aria-label="Row limit"
          data-testid="row-limit"
        >
          {ROW_LIMITS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost h-7" onClick={beautify} title={`Format the SQL (${MOD}I)`} data-testid="beautify">
          <WandSparkles size={14} /> Beautify
        </button>
        <button
          className="btn btn-ghost h-7"
          onClick={() => saveQuery(false)}
          title={tab.savedQueryId ? `Update the saved query (${MOD}S) — ${MOD}⇧S saves a copy` : `Save to Queries (${MOD}S)`}
          data-testid="save-query"
        >
          <Save size={14} /> {tab.savedQueryId ? 'Save' : 'Save…'}
        </button>
        <div className="relative">
          <button className={cx('btn btn-ghost h-7', historyOpen && 'bg-surface-2')} onClick={openHistory} title="Queries run on this connection">
            <HistoryIcon size={14} /> History
          </button>
          {historyOpen && (
            <div className="fade-in absolute left-0 top-8 z-30 max-h-80 w-[520px] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow)]">
              {history.length === 0 && <div className="px-3 py-2 text-ink-3">No queries yet.</div>}
              {history.map((h) => (
                <button
                  key={h.id}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                  onClick={() => {
                    setSql(h.sql);
                    setHistoryOpen(false);
                  }}
                >
                  <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', h.ok ? 'bg-success' : 'bg-danger')} />
                  <span className="mono line-clamp-2 min-w-0 flex-1 text-[11.5px] text-ink">{h.sql}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{new Date(h.executedAt).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-ghost h-7" onClick={saveSqlFile} title="Save the editor text to a .sql file">
          <FileDown size={14} /> .sql
        </button>
        <div className="flex-1" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <ResultPanel
          runs={runs}
          index={Math.min(runIndex, runs.length - 1)}
          onIndex={(i) => setRunIndex(Math.max(0, Math.min(i, runs.length - 1)))}
          onResultIndex={(ri, i) => setRuns((rs) => rs.map((r, k) => (k === ri ? { ...r, current: i } : r)))}
          running={running}
          engine={session.config.engine}
          name={tab.title.replace(/\s+/g, '_').toLowerCase()}
          onAskClaude={(text) => useChat.getState().compose(id, text)}
        />
      </div>
      {saveDialog && <SaveQueryDialog initialName={saveDialog.name} onSave={saveAs} onClose={() => setSaveDialog(null)} />}
    </div>
  );
}
