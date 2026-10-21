import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FolderOpen, Loader2, Maximize, Minus, Plus, RefreshCw, Send, Sparkles, Table2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diagramPrompt, focusedTables, groupTables, hubTables, layout, nameAffixes, nameMatcher, neighbourMap, nodeSize, presetQuestions, relationsOf, visibleColumns, type Relation } from '../lib/diagram';
import { diffSchema, hasChanges, summaryText, type TableView } from '../lib/schemaDiff';
import { cx, formatCount } from '../lib/ui';
import { tableKey, useApp, type DiagramTab as DiagramTabType } from '../store/app';
import { useChat } from '../store/chat';
import { useDiagramView, type DiagramActions } from '../store/diagramView';
import { schemaWithKeys } from '../lib/virtualKeys';
import { emptySchema, useSchema, useVirtualKeys } from '../store/schema';
import { useConnectionId, useWs, useWsActions } from '../store/workspace';
import { CenteredState } from './DataTab';
import DiagramTableNode, { COMPACT_ZOOM, type TableNodeType } from './DiagramTableNode';

const nodeTypes: NodeTypes = { table: DiagramTableNode };
/** more linked tables than this: start in focus mode */
const FOCUS_FROM = 120;
const TONE = { base: 'var(--text-3)', sel: 'var(--accent)', add: 'var(--success)', rem: 'var(--danger)' } as const;
type Tone = keyof typeof TONE;
/** group colours in the outline and on the boxes */
const GROUP_COLORS = ['oklch(0.66 0.13 45)', 'oklch(0.6 0.1 230)', 'oklch(0.6 0.1 150)', 'oklch(0.62 0.12 300)', 'oklch(0.7 0.12 85)', 'oklch(0.62 0.1 190)', 'oklch(0.6 0.14 0)', 'oklch(0.58 0.07 260)'];
export const OTHER_COLOR = 'var(--text-3)';
const HINT_KEY = 'rowline.diagramHint';

/**
 * Line ends that show the relation type: an open circle at the "many" end (the foreign key side),
 * a filled one at the "one" end.
 */
function RelationMarkers() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        {Object.entries(TONE).map(([tone, color]) => (
          <g key={tone}>
            <marker id={`rl-many-${tone}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse">
              <circle cx="5" cy="5" r="3.4" fill="var(--surface)" style={{ stroke: color }} strokeWidth="1.5" />
            </marker>
            <marker id={`rl-one-${tone}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse">
              <circle cx="5" cy="5" r="3.4" style={{ fill: color }} />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}

export default function DiagramTab(props: { tab: DiagramTabType; active: boolean }) {
  return (
    <ReactFlowProvider>
      <Diagram {...props} />
    </ReactFlowProvider>
  );
}

function Diagram({ tab, active }: { tab: DiagramTabType; active: boolean }) {
  const cid = useConnectionId();
  const session = useWs((w) => w.session);
  const config = useApp((s) => s.connections.find((c) => c.id === cid)) ?? session.config;
  const themeMode = useApp((s) => s.theme);
  const { openTable, updateTab } = useWsActions();
  const database = tab.database;
  const key = tableKey(cid, database);
  const entry = useSchema((s) => s.entries[key]) ?? emptySchema;
  const flow = useReactFlow<TableNodeType, Edge>();
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM);
  const hover = useDiagramView((s) => s.hover[tab.id] ?? null);
  const query = useDiagramView((s) => s.query[tab.id] ?? '')
    .trim()
    .toLowerCase();

  const [showChanges, setShowChanges] = useState(true);
  /** also draw relations guessed from column names (many old schemas have no foreign keys) */
  const [guess, setGuess] = useState(true);
  /** hide tables that have no relation to any other table */
  const [hideLonely, setHideLonely] = useState(true);
  /** hidden tables shown anyway because they were searched for */
  const [forced, setForced] = useState<Set<string>>(new Set());
  /** focus mode (big databases): tables chosen to show, each with its neighbours */
  const [roots, setRoots] = useState<string[]>([]);
  /** big database, but the user asked for everything */
  const [showAll, setShowAll] = useState(false);
  /** only tables whose name matches (`tbl_*`, `*_log`), plus the tables chosen in focus mode */
  const [namePattern, setNamePattern] = useState<string | null>(null);
  const [patternDraft, setPatternDraft] = useState('');
  /** "Ask Claude" opened for the selected table */
  const [askOpen, setAskOpen] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const [laying, setLaying] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const layoutSeq = useRef(0);

  useEffect(() => {
    if (active) useSchema.getState().load(cid, database);
  }, [active, cid, database]);

  const compare = entry.compareTo >= 0 ? entry.snapshots[entry.compareTo] ?? null : null;
  // saved virtual foreign keys count as relations (also in the snapshot, so they never show as a change)
  const virtualKeys = useVirtualKeys(cid, database);
  const diff = useMemo(
    () => (entry.live ? diffSchema(showChanges && compare ? schemaWithKeys(compare.tables, virtualKeys) : null, schemaWithKeys(entry.live, virtualKeys)) : null),
    [entry.live, compare, showChanges, virtualKeys],
  );
  const tables = useMemo(() => diff?.tables ?? [], [diff]);
  const byName = useMemo(() => new Map(tables.map((t) => [t.name, t])), [tables]);
  const relations = useMemo(() => relationsOf(tables, guess), [tables, guess]);
  // columns that take part in a relation: shown in the boxes (with keys)
  const relatedCols = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (t: string, cols: string[]) => cols.forEach((c) => (m.get(t) ?? m.set(t, new Set()).get(t)!).add(c));
    for (const r of relations) {
      add(r.from, r.fromColumns);
      add(r.to, r.toColumns);
    }
    return m;
  }, [relations]);
  const links = useMemo(() => neighbourMap(relations), [relations]);
  const candidates = useMemo(() => (hideLonely ? tables.filter((t) => relatedCols.has(t.name) || forced.has(t.name)) : tables), [tables, hideLonely, relatedCols, forced]);
  const lonely = tables.length - tables.filter((t) => relatedCols.has(t.name)).length;
  // hundreds of tables at once are slow to draw (the app's web view gave up) and impossible to read:
  // big databases start in focus mode
  const big = candidates.length > FOCUS_FROM && !showAll;
  const shownTables = useMemo(() => {
    const named = namePattern ? nameMatcher(namePattern) : null;
    if (!big && !named) return candidates;
    const focus = focusedTables(roots, links);
    return candidates.filter((t) => focus.has(t.name) || forced.has(t.name) || named?.(t.name));
  }, [big, candidates, roots, links, forced, namePattern]);
  const affixes = useMemo(() => (big ? nameAffixes(candidates.map((t) => t.name)) : []), [big, candidates]);
  // a new name filter starts a new view: tables added before are dropped
  const filterByName = useCallback((p: string | null) => {
    setNamePattern(p?.trim() || null);
    setPatternDraft('');
    setRoots([]);
    setForced(new Set());
  }, []);
  const hubs = useMemo(() => (big ? hubTables(links) : []), [big, links]);
  const addRoot = useCallback((name: string) => setRoots((r) => (r.includes(name) ? r : [...r, name])), []);

  const groups = useMemo(() => groupTables(shownTables.map((t) => t.name), links), [shownTables, links]);
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    groups.forEach((g, i) => g.tables.forEach((t) => m.set(t, g.hub ? GROUP_COLORS[i % GROUP_COLORS.length] : OTHER_COLOR)));
    return m;
  }, [groups]);

  // layout whenever the shown tables change
  useEffect(() => {
    if (!shownTables.length) {
      setNodes([]);
      return;
    }
    const seq = ++layoutSeq.current;
    setLaying(true);
    const sized = shownTables.map((t) => ({ t, columns: visibleColumns(t, relatedCols.get(t.name)), size: nodeSize(t, relatedCols.get(t.name)) }));
    layout(
      sized.map(({ t, size }) => ({ id: t.name, ...size })),
      relations,
    )
      .then((pos) => {
        if (seq !== layoutSeq.current) return;
        // the box gets exactly the size the layout used, so boxes never overlap
        setNodes(
          sized.map(({ t, columns, size }) => ({
            id: t.name,
            type: 'table',
            position: pos[t.name] ?? { x: 0, y: 0 },
            style: { width: size.width },
            data: { table: t, columns, color: OTHER_COLOR, dim: false, focus: false, active: [] },
          })),
        );
        requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1 }));
      })
      .finally(() => seq === layoutSeq.current && setLaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTables, relations]);

  useEffect(() => {
    const shown = new Set(shownTables.map((t) => t.name));
    // compact boxes have no column rows: lines start and end at the table name
    const visible = (table: string, col: string) => {
      const t = byName.get(table);
      return !compact && !!t && visibleColumns(t, relatedCols.get(table)).some((c) => c.name === col);
    };
    setEdges((prev) => {
      const wasSelected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return relations
        .filter((r) => shown.has(r.from) && shown.has(r.to))
        .map((r) => {
          const tone: Tone = r.change === 'added' ? 'add' : r.change === 'removed' ? 'rem' : 'base';
          return {
            id: r.id,
            source: r.from,
            target: r.to,
            sourceHandle: r.fromColumns.length === 1 && visible(r.from, r.fromColumns[0]) ? `${r.fromColumns[0]}-out` : 'table-out',
            targetHandle: r.toColumns.length === 1 && visible(r.to, r.toColumns[0]) ? `${r.toColumns[0]}-in` : 'table-in',
            selected: wasSelected.has(r.id),
            data: { relation: r, tone },
          };
        });
    });
  }, [relations, shownTables, byName, relatedCols, setEdges, compact]);

  const focusTable = useCallback(
    (name: string) => {
      // not on the diagram (hidden, or not chosen yet in focus mode): show it, then focus it after the layout
      if (!flow.getNode(name)) {
        updateTab(tab.id, { focus: name });
        return;
      }
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === name })));
      setEdges((es) => es.map((e) => ({ ...e, selected: false })));
      flow.fitView({ nodes: [{ id: name }], duration: 400, maxZoom: 1.1, padding: 0.6 });
    },
    [flow, setNodes, setEdges, updateTab, tab.id],
  );

  // a table to show (from the sidebar or a "show on diagram" link)
  useEffect(() => {
    if (!tab.focus || laying) return;
    if (!nodes.some((n) => n.id === tab.focus)) {
      // not on the diagram yet: show it (with its neighbours in focus mode); this runs again after the layout
      if (big) addRoot(tab.focus);
      else setForced((f) => (f.has(tab.focus!) ? f : new Set(f).add(tab.focus!)));
      return;
    }
    focusTable(tab.focus);
    updateTab(tab.id, { focus: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.focus, laying, nodes.length, big]);

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  const selectedNames = useMemo(() => {
    const s = new Set(selectedNodes.map((n) => n.id));
    for (const e of selectedEdges) {
      s.add(e.source);
      s.add(e.target);
    }
    return s;
  }, [selectedNodes, selectedEdges]);

  // one selected table is "pinned": the outline shows it, its relations stay bright
  const single = selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0].id : null;
  useEffect(() => setAskOpen(false), [single]);
  // the table under the mouse wins over the selected one
  const focus = hover && byName.has(hover) ? hover : single;
  const focusRels = useMemo(() => (focus ? relations.filter((r) => r.from === focus || r.to === focus) : []), [focus, relations]);
  const neighbours = useMemo(() => (focus ? new Set([focus, ...focusRels.flatMap((r) => [r.from, r.to])]) : null), [focus, focusRels]);

  const queryMatch = useMemo(() => nameMatcher(query), [query]);
  // node objects are reused while their look stays the same, so hovering does not redraw every box
  const nodeCache = useRef(new Map<string, { key: string; base: TableNodeType; out: TableNodeType }>());
  const shownNodes = useMemo(() => {
    const active = new Map<string, string[]>();
    const add = (t: string, cols: string[]) => active.set(t, [...(active.get(t) ?? []), ...cols]);
    for (const r of focusRels) {
      add(r.from, r.fromColumns);
      add(r.to, r.toColumns);
    }
    const cache = nodeCache.current;
    const next = new Map<string, { key: string; base: TableNodeType; out: TableNodeType }>();
    const out = nodes.map((n) => {
      const color = colorOf.get(n.id) ?? OTHER_COLOR;
      const dim = (!!neighbours && !neighbours.has(n.id)) || (!!query && !queryMatch(n.id));
      const cols = active.get(n.id) ?? [];
      const k = `${color}|${dim}|${n.id === focus}|${cols.join(',')}`;
      const hit = cache.get(n.id);
      const node = hit && hit.base === n && hit.key === k ? hit.out : { ...n, data: { ...n.data, color, dim, focus: n.id === focus, active: cols } };
      next.set(n.id, { key: k, base: n, out: node });
      return node;
    });
    nodeCache.current = next;
    return out;
  }, [nodes, neighbours, focus, focusRels, colorOf, query, queryMatch]);

  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const { relation: r, tone } = e.data as { relation: Relation; tone: Tone };
        const on = e.selected || (!!focus && (e.source === focus || e.target === focus));
        const t: Tone = on ? 'sel' : tone;
        return {
          ...e,
          type: 'default',
          // relation type at the ends: open circle = many (the foreign key side), filled = one
          markerStart: `rl-${r.kind === 'one-to-one' ? 'one' : 'many'}-${t}`,
          markerEnd: `rl-one-${t}`,
          zIndex: on ? 1 : 0,
          style: {
            stroke: TONE[t],
            strokeWidth: on ? 1.8 : 1.1,
            strokeDasharray: r.change === 'removed' || r.guessed ? '4 4' : r.virtual ? '1.5 3' : undefined,
            opacity: focus ? (on ? 1 : 0.1) : query ? 0.35 : 0.75,
          },
        };
      }),
    [edges, focus, query],
  );

  // the sidebar outline: tables by group, the selected table and what it can do
  const actionsRef = useRef<DiagramActions>(null!);
  actionsRef.current = {
    pin: (name) => {
      if (name) focusTable(name);
      else {
        setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
        setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
      }
    },
    open: (name, view) => openTable(name, byName.get(name)?.kind, view),
    ask: () => setAskOpen(true),
    saveGuess: (r) => useSchema.getState().saveKey(cid, database, { table: r.from, columns: r.fromColumns, refTable: r.to, refColumns: r.toColumns }),
    removeVirtual: (r) => {
      const k = virtualKeys.find((v) => v.table === r.from && v.columns.join(',') === r.fromColumns.join(','));
      if (k) useSchema.getState().deleteKey(cid, database, k.id);
    },
    expand: addRoot,
    filterByName,
  };
  const actions = useMemo<DiagramActions>(
    () => ({
      pin: (n) => actionsRef.current.pin(n),
      open: (n, v) => actionsRef.current.open(n, v),
      ask: () => actionsRef.current.ask(),
      saveGuess: (r) => actionsRef.current.saveGuess(r),
      removeVirtual: (r) => actionsRef.current.removeVirtual(r),
      expand: (n) => actionsRef.current.expand(n),
      filterByName: (p) => actionsRef.current.filterByName(p),
    }),
    [],
  );
  const expandable = useMemo(() => new Set(big || namePattern ? shownTables.map((t) => t.name).filter((n) => !roots.includes(n)) : []), [big, namePattern, shownTables, roots]);
  useEffect(() => {
    useDiagramView.getState().publish(tab.id, { tables: shownTables, allTables: tables, relations, groups, colors: colorOf, pinned: single, expandable, namePattern, actions });
  }, [tab.id, shownTables, tables, relations, groups, colorOf, single, expandable, namePattern, actions]);
  useEffect(() => () => useDiagramView.getState().drop(tab.id), [tab.id]);

  const isDark = themeMode === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false) : themeMode === 'dark';
  const summary = diff?.summary;
  const since = compare ? new Date(compare.takenAt).toLocaleString() : null;
  const showAsk = askOpen || selectedNodes.length > 1 || selectedEdges.length > 0;
  const clearSelection = () => actions.pin(null);
  const hideHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, 'off');
    } catch {
      /* the hint comes back next time */
    }
  };

  if (entry.error) return <CenteredState error={entry.error} onRetry={() => useSchema.getState().load(cid, database, true)} />;
  if (!entry.live) return <CenteredState loading />;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col" data-testid="diagram">
      <div className="flex h-10 shrink-0 items-center gap-3.5 border-b border-line px-3 text-[12.5px]">
        <span className="shrink-0 whitespace-nowrap text-ink-2" data-testid="focus-info">
          <b className="font-semibold text-ink">{formatCount(shownTables.length)}</b> of {formatCount(tables.length)} tables
          {hideLonely && lonely > 0 && <> · {formatCount(lonely)} unrelated hidden</>}
          {namePattern && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-accent-soft py-px pl-2 pr-1 align-middle text-[12px] text-ink" data-testid="name-filter">
              <span className="mono">{namePattern}</span>
              <button className="rounded px-0.5 text-ink-3 hover:text-ink" onClick={() => filterByName(null)} title="Show all tables again" aria-label="Remove the name filter">
                <X size={11} />
              </button>
            </span>
          )}
          {big && (roots.length > 0 || namePattern) && (
            <button className="ml-1.5 text-link hover:underline" onClick={() => filterByName(null)}>
              Clear
            </button>
          )}
          {showAll && candidates.length > FOCUS_FROM && (
            <button className="ml-1.5 text-link hover:underline" onClick={() => setShowAll(false)}>
              Focus mode
            </button>
          )}
        </span>
        <div className="h-[18px] w-px shrink-0 bg-line" />
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-ink-2" title="Draw relations guessed from column names (customer_id → customers.id) where the database has no foreign key">
          <input type="checkbox" className="accent-[var(--accent)]" checked={guess} onChange={(e) => setGuess(e.target.checked)} data-testid="guess-relations" /> Guessed relations
        </label>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-ink-2" title="Hide tables that are not related to any other table; search still finds them">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={hideLonely}
            onChange={(e) => {
              setHideLonely(e.target.checked);
              setForced(new Set());
            }}
            data-testid="hide-lonely"
          />
          Hide unrelated
        </label>
        {/* schema changes since a snapshot */}
        {entry.snapshots.length > 0 && (
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[12px]" data-testid="schema-changes">
            <div className="h-[18px] w-px shrink-0 bg-line" />
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-ink-2">
              <input type="checkbox" className="accent-[var(--accent)]" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Changes since
            </label>
            <select
              className="h-7 min-w-0 max-w-[170px] shrink rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink-2"
              value={entry.compareTo}
              onChange={(e) => useSchema.getState().setCompare(cid, database, Number(e.target.value))}
              disabled={!showChanges}
              aria-label="Compare with snapshot"
            >
              {entry.snapshots.map((s, i) => (
                <option key={s.takenAt} value={i}>
                  {new Date(s.takenAt).toLocaleString()}
                </option>
              ))}
            </select>
            {showChanges && summary && (
              <span className={cx('truncate', hasChanges(summary) ? 'font-medium text-warning' : 'text-ink-3')} title={summaryText(summary)}>
                {summaryText(summary)}
              </span>
            )}
          </div>
        )}
        <div className="flex-1" />
        <button className="btn btn-ghost h-7 shrink-0 gap-1.5 px-2.5 text-ink-2" onClick={() => flow.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })} title="Fit everything in view">
          <Maximize size={13} /> Fit
        </button>
        <button className="btn btn-ghost h-7 shrink-0 gap-1.5 px-2.5 text-ink-2" onClick={() => useSchema.getState().load(cid, database, true)} title="Read the schema again">
          {entry.loading || laying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <RelationMarkers />
        {big && shownTables.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6" data-testid="focus-start">
            <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow)]">
              <div className="text-[14px] font-semibold text-ink">{formatCount(candidates.length)} related tables</div>
              <p className="mt-1 text-[12.5px] text-ink-2">Too many to read at once. Pick a table (or find one in the sidebar): it is shown with the tables it links to. Add more from the sidebar.</p>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Most linked</div>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {hubs.map((h) => (
                  <button key={h.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-surface-2" onClick={() => addRoot(h.name)}>
                    <Table2 size={12} className="shrink-0 text-ink-3" />
                    <span className="mono min-w-0 flex-1 truncate">{h.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{h.links}</span>
                  </button>
                ))}
              </div>
              <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-3">By name</div>
              {affixes.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {affixes.map((a) => (
                    <button key={a.pattern} className="flex h-6 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[12px] hover:bg-surface-3" onClick={() => filterByName(a.pattern)} data-testid="name-affix">
                      <span className="mono text-ink">{a.pattern}</span>
                      <span className="tabular-nums text-ink-3">{a.tables}</span>
                    </button>
                  ))}
                </div>
              )}
              <form
                className="mt-2 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (patternDraft.trim()) filterByName(patternDraft);
                }}
              >
                <input className="field mono h-7 text-[12.5px]" placeholder="tbl_*  ·  *_log  ·  any part of the name" value={patternDraft} onChange={(e) => setPatternDraft(e.target.value)} data-testid="name-pattern" />
                <button type="submit" className="btn h-7 shrink-0 px-2.5" disabled={!patternDraft.trim()}>
                  Show
                </button>
              </form>
              {patternDraft.trim() && <div className="mt-1 text-[11.5px] text-ink-3">{formatCount(candidates.filter((t) => nameMatcher(patternDraft)(t.name)).length)} matching tables</div>}
              <button className="btn btn-ghost mt-3 h-7 text-ink-3" onClick={() => setShowAll(true)} title="Draws every table; can be slow or crash on very big databases">
                Show all {formatCount(candidates.length)} tables (slow)
              </button>
            </div>
          </div>
        )}
        <ReactFlow
          nodes={shownNodes}
          edges={shownEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          colorMode={isDark ? 'dark' : 'light'}
          style={{ background: 'color-mix(in srgb, var(--surface-2) 45%, var(--bg))' }}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeDoubleClick={(_, n) => openTable(n.id)}
          onNodeMouseEnter={(_, n) => useDiagramView.getState().setHover(tab.id, n.id)}
          onNodeMouseLeave={() => useDiagramView.getState().setHover(tab.id, null)}
          onPaneClick={() => setAskOpen(false)}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border-strong)" />
          <Panel position="bottom-left" className="!m-3.5 flex items-center gap-2.5">
            <ZoomBar onFit={() => flow.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })} />
            <Legend compact={compact} virtual={relations.some((r) => r.virtual)} />
          </Panel>
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="!m-3.5 overflow-hidden !rounded-lg border border-line-strong"
            style={{ width: 172, height: 116 }}
            bgColor="var(--surface)"
            nodeBorderRadius={2}
            maskColor={isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)'}
            maskStrokeColor="var(--accent)"
            maskStrokeWidth={2}
            nodeColor={(n) =>
              n.id === focus ? 'var(--accent)' : (n.data as { table: TableView }).table.change ? 'var(--warning)' : !neighbours || neighbours.has(n.id) ? 'var(--text-3)' : 'var(--border-strong)'
            }
          />
        </ReactFlow>
        {laying && (
          <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 shadow-sm">
            <Loader2 size={12} className="animate-spin" /> Arranging {formatCount(shownTables.length)} tables…
          </div>
        )}
        {showAsk && selectedNames.size > 0 && (
          <AskBar
            key={[...selectedNames].sort().join('|')}
            tables={[...selectedNames].map((n) => byName.get(n)).filter((t): t is TableView => !!t)}
            relations={relationsBetween(relations, selectedNames, selectedEdges)}
            onClear={() => (askOpen && single ? setAskOpen(false) : clearSelection())}
            onAsk={(question, ts, rs) =>
              useChat.getState().compose(
                cid,
                diagramPrompt({ question, database, engine: session.config.engine, tables: ts, relations: rs, changesSince: showChanges ? since : null, projectFolder: config.projectFolder ?? null }),
              )
            }
            projectFolder={config.projectFolder ?? null}
            onConnectProject={() => useApp.getState().setEditing({ ...config })}
            showChanges={showChanges}
          />
        )}
        {hint && !showAsk && !laying && !(big && shownTables.length === 0) && (
          <div className="absolute left-1/2 top-3 z-[5] flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full bg-ink py-1.5 pl-3.5 pr-2 text-[12px] text-bg shadow-sm" data-testid="diagram-hint">
            Click a table to focus its relations · double-click opens data · ⇧-drag selects several
            <button className="rounded-full px-1 opacity-70 hover:opacity-100" onClick={hideHint} aria-label="Hide the hint">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** − 100% + : the zoom, with a click on the number fitting everything */
function ZoomBar({ onFit }: { onFit: () => void }) {
  const zoom = useStore((s) => s.transform[2]);
  const flow = useReactFlow();
  return (
    <div className="flex items-center rounded-lg border border-line-strong bg-surface shadow-sm" data-testid="zoom-bar">
      <button className="flex h-[30px] w-[30px] items-center justify-center text-ink-2 hover:text-ink" onClick={() => flow.zoomOut({ duration: 150 })} aria-label="Zoom out">
        <Minus size={14} />
      </button>
      <button className="w-12 text-center text-[12px] tabular-nums text-ink-2 hover:text-ink" onClick={onFit} title="Fit everything in view">
        {Math.round(zoom * 100)}%
      </button>
      <button className="flex h-[30px] w-[30px] items-center justify-center text-ink-2 hover:text-ink" onClick={() => flow.zoomIn({ duration: 150 })} aria-label="Zoom in">
        <Plus size={14} />
      </button>
    </div>
  );
}

/** What the lines and their ends mean */
function Legend({ compact, virtual }: { compact: boolean; virtual: boolean }) {
  const line = (dash?: string) => <svg width="22" height="2" className="shrink-0" aria-hidden><line x1="0" y1="1" x2="22" y2="1" stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray={dash} /></svg>;
  return (
    <div className="flex items-center gap-3.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 py-[7px] text-[11.5px] text-ink-2 shadow-sm" data-testid="diagram-legend">
      <span className="flex items-center gap-1.5">{line()}Foreign key</span>
      <span className="flex items-center gap-1.5">{line('4 4')}Guessed</span>
      {virtual && <span className="flex items-center gap-1.5">{line('1.5 3')}Virtual</span>}
      <span className="flex items-center gap-1.5">
        <span className="h-[7px] w-[7px] rounded-full border-[1.4px] border-ink-3" />
        many
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[7px] w-[7px] rounded-full bg-ink-3" />
        one
      </span>
      <span className="text-ink-3">{compact ? 'Zoom in to see key columns' : 'Zoom out for names only'}</span>
    </div>
  );
}

/** Relations to send with a selection: the selected lines and every line between two selected tables */
function relationsBetween(all: Relation[], names: Set<string>, selectedEdges: Edge[]): Relation[] {
  const picked = new Set(selectedEdges.map((e) => e.id));
  // one table: everything that points to it or from it
  if (names.size === 1 && !picked.size) return all.filter((r) => names.has(r.from) || names.has(r.to));
  return all.filter((r) => picked.has(r.id) || (names.has(r.from) && names.has(r.to)));
}

function AskBar({
  tables,
  relations,
  onAsk,
  onClear,
  projectFolder,
  onConnectProject,
  showChanges,
}: {
  tables: TableView[];
  relations: Relation[];
  onAsk: (question: string, tables: TableView[], relations: Relation[]) => void;
  onClear: () => void;
  projectFolder: string | null;
  onConnectProject: () => void;
  showChanges: boolean;
}) {
  const [question, setQuestion] = useState('');
  const changed = showChanges && tables.some((t) => t.change || t.columns.some((c) => c.change) || t.foreignKeys.some((f) => f.change));
  const presets = presetQuestions(tables.length, changed);
  return (
    <div className="fade-in absolute left-1/2 top-3 z-10 w-[min(640px,calc(100%-24px))] -translate-x-1/2 rounded-xl border border-line-strong bg-surface p-2.5 shadow-[var(--shadow)]" data-testid="ask-bar">
      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <Sparkles size={13} className="text-accent" />
        <span className="font-medium text-ink">Ask Claude about</span>
        <span className="truncate text-ink-2">
          {tables.length} table{tables.length === 1 ? '' : 's'}
          {relations.length ? ` · ${relations.length} relation${relations.length === 1 ? '' : 's'}` : ''}
        </span>
        <div className="flex-1" />
        <button className="icon-btn h-6 w-6" onClick={onClear} title="Clear the selection" aria-label="Clear selection">
          <X size={13} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button key={p.label} className="h-6 rounded-md bg-surface-2 px-2.5 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink" onClick={() => onAsk(p.question, tables, relations)}>
            {p.label}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) onAsk(question, tables, relations);
        }}
      >
        <input className="field h-7 text-[12.5px]" placeholder="Or ask your own question…" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button type="submit" className="btn btn-primary h-7 px-2.5" disabled={!question.trim()} aria-label="Ask">
          <Send size={12} />
        </button>
      </form>
      {!projectFolder && (
        <button className="mt-2 flex items-center gap-1.5 text-[11.5px] text-link hover:underline" onClick={onConnectProject}>
          <FolderOpen size={12} /> Connect a project folder for better answers (Claude reads your models and migrations)
        </button>
      )}
      <div className="mt-1.5 text-[11px] text-ink-3">Opens the Claude panel with the question and these tables as context; you can edit it before sending.</div>
    </div>
  );
}
