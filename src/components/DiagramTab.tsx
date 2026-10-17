import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Check, FolderOpen, Loader2, Maximize, RefreshCw, Search, Send, Sparkles, Table2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diagramPrompt, focusedTables, hubTables, kindLabel, layout, neighbourMap, nodeSize, presetQuestions, relationsOf, visibleColumns, type Relation } from '../lib/diagram';
import { diffSchema, hasChanges, summaryText, type TableView } from '../lib/schemaDiff';
import { cx, formatCount } from '../lib/ui';
import { tableKey, useApp, type DiagramTab as DiagramTabType } from '../store/app';
import { useChat } from '../store/chat';
import { schemaWithKeys } from '../lib/virtualKeys';
import { emptySchema, useSchema, useVirtualKeys } from '../store/schema';
import { useConnectionId, useWs, useWsActions } from '../store/workspace';
import { CenteredState } from './DataTab';
import DiagramTableNode, { type TableNodeType } from './DiagramTableNode';

const nodeTypes: NodeTypes = { table: DiagramTableNode };
/** more linked tables than this: start in focus mode */
const FOCUS_FROM = 120;
const TONE = { base: 'var(--text-3)', sel: 'var(--sel-strong)', add: 'var(--success)', rem: 'var(--danger)' } as const;

/**
 * Line ends that show the relation type (drawn as at the end of a line, the table to the right):
 * many = crow's foot, one = bar, zone = zero or one (circle and bar, the column can be NULL).
 */
function RelationMarkers() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        {Object.entries(TONE).map(([tone, color]) => (
          <g key={tone}>
            <marker id={`rl-many-${tone}`} viewBox="0 0 20 20" refX="19" refY="10" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M7 10 L19 3 M7 10 L19 10 M7 10 L19 17 M5 4 L5 16" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
            </marker>
            <marker id={`rl-one-${tone}`} viewBox="0 0 20 20" refX="19" refY="10" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M11 3 L11 17 M15 3 L15 17" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
            </marker>
            <marker id={`rl-zone-${tone}`} viewBox="0 0 20 20" refX="19" refY="10" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <circle cx="7" cy="10" r="3.5" fill="var(--surface)" style={{ stroke: color }} strokeWidth="1.5" />
              <path d="M15 3 L15 17" fill="none" style={{ stroke: color }} strokeWidth="1.5" />
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
  const [search, setSearch] = useState('');
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
    if (!big) return candidates;
    const focus = focusedTables(roots, links);
    return candidates.filter((t) => focus.has(t.name) || forced.has(t.name));
  }, [big, candidates, roots, links, forced]);
  const hubs = useMemo(() => (big ? hubTables(links) : []), [big, links]);
  const addRoot = useCallback((name: string) => setRoots((r) => (r.includes(name) ? r : [...r, name])), []);

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
            data: { table: t, columns, dim: false, related: false },
          })),
        );
        requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1 }));
      })
      .finally(() => seq === layoutSeq.current && setLaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTables, relations]);

  useEffect(() => {
    const shown = new Set(shownTables.map((t) => t.name));
    const visible = (table: string, col: string) => {
      const t = byName.get(table);
      return !!t && visibleColumns(t, relatedCols.get(table)).some((c) => c.name === col);
    };
    setEdges(
      relations
        .filter((r) => shown.has(r.from) && shown.has(r.to))
        .map((r) => {
          const tone = r.change === 'added' ? 'add' : r.change === 'removed' ? 'rem' : 'base';
          return {
            id: r.id,
            source: r.from,
            target: r.to,
            sourceHandle: r.fromColumns.length === 1 && visible(r.from, r.fromColumns[0]) ? `${r.fromColumns[0]}-out` : 'table-out',
            targetHandle: r.toColumns.length === 1 && visible(r.to, r.toColumns[0]) ? `${r.toColumns[0]}-in` : 'table-in',
            type: 'smoothstep',
            // relation type at the ends: crow's foot = many, bar = one, circle = optional (the column can be NULL)
            markerStart: `rl-${r.kind === 'one-to-one' ? 'one' : 'many'}-${tone}`,
            markerEnd: `rl-${r.optional ? 'zone' : 'one'}-${tone}`,
            label: `${kindLabel(r)}${r.guessed ? ' · guessed' : r.virtual ? ' · virtual' : ''}`,
            labelStyle: { fontSize: 10, fill: 'var(--text-3)' },
            labelBgStyle: { fill: 'var(--surface)' },
            labelBgPadding: [4, 2] as [number, number],
            style: { stroke: TONE[tone], strokeWidth: 1.5, strokeDasharray: r.change === 'removed' || r.guessed ? '5 4' : r.virtual ? '1.5 3' : undefined },
            data: { relation: r, tone },
          };
        }),
    );
  }, [relations, shownTables, byName, relatedCols, setEdges]);

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

  // one selected table: its neighbours stay bright, the rest fades
  const single = selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0].id : null;
  const neighbours = useMemo(() => {
    if (!single) return null;
    const s = new Set<string>([single]);
    for (const r of relations) {
      if (r.from === single) s.add(r.to);
      if (r.to === single) s.add(r.from);
    }
    return s;
  }, [single, relations]);
  const shownNodes = useMemo(
    () => nodes.map((n) => (neighbours ? { ...n, data: { ...n.data, dim: !neighbours.has(n.id), related: neighbours.has(n.id) && n.id !== single } } : n)),
    [nodes, neighbours, single],
  );
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const on = e.selected || (single && (e.source === single || e.target === single));
        const r = (e.data as { relation: Relation }).relation;
        // labels only where they help: highlighted lines, or small diagrams
        const label = on || edges.length <= 40 ? e.label : undefined;
        if (on)
          return {
            ...e,
            label,
            animated: true,
            markerStart: `rl-${r.kind === 'one-to-one' ? 'one' : 'many'}-sel`,
            markerEnd: `rl-${r.optional ? 'zone' : 'one'}-sel`,
            style: { ...e.style, stroke: TONE.sel, strokeWidth: 2 },
          };
        return neighbours ? { ...e, label: undefined, style: { ...e.style, opacity: 0.25 } } : { ...e, label };
      }),
    [edges, single, neighbours],
  );

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [search, tables]);

  const isDark = themeMode === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false) : themeMode === 'dark';
  const summary = diff?.summary;
  const since = compare ? new Date(compare.takenAt).toLocaleString() : null;

  if (entry.error) return <CenteredState error={entry.error} onRetry={() => useSchema.getState().load(cid, database, true)} />;
  if (!entry.live) return <CenteredState loading />;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col" data-testid="diagram">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <div className="relative w-48 shrink-0">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            className="field h-7 pl-8 text-[12.5px]"
            placeholder={`Find among ${formatCount(tables.length)} tables`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) {
                focusTable(matches[0].name);
                setSearch('');
              }
              if (e.key === 'Escape') setSearch('');
            }}
            data-testid="diagram-search"
          />
          {matches.length > 0 && (
            <div className="fade-in absolute left-0 top-8 z-30 w-72 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
              {matches.map((t) => (
                <button
                  key={t.name}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3"
                  onClick={() => {
                    focusTable(t.name);
                    setSearch('');
                  }}
                >
                  <Table2 size={12} className="shrink-0 text-ink-3" /> <span className="mono truncate">{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2" title="Draw relations guessed from column names (customer_id → customers.id) where the database has no foreign key">
          <input type="checkbox" checked={guess} onChange={(e) => setGuess(e.target.checked)} data-testid="guess-relations" /> Guessed relations
        </label>
        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2" title="Hide tables that are not related to any other table; search still finds them">
          <input
            type="checkbox"
            checked={hideLonely}
            onChange={(e) => {
              setHideLonely(e.target.checked);
              setForced(new Set());
            }}
            data-testid="hide-lonely"
          />{' '}
          Hide unrelated{lonely ? ` (${formatCount(lonely)})` : ''}
        </label>
        <div className="mx-0.5 h-5 w-px bg-line" />
        {/* schema changes since a snapshot */}
        {entry.snapshots.length ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[12px]" data-testid="schema-changes">
            <label className="flex shrink-0 items-center gap-1.5 text-ink-2">
              <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Changes since
            </label>
            <select
              className="h-7 min-w-0 max-w-[190px] shrink rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink-2"
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
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">Mark the schema as seen to see later changes (new tables, columns, keys).</span>
        )}
        {(big || showAll) && candidates.length > FOCUS_FROM && (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3" data-testid="focus-info">
            {big ? `${formatCount(shownTables.length)} of ${formatCount(candidates.length)} tables` : 'All tables'}
            {big && roots.length > 0 && (
              <button className="text-link hover:underline" onClick={() => (setRoots([]), setForced(new Set()))}>
                Clear
              </button>
            )}
            {showAll && (
              <button className="text-link hover:underline" onClick={() => setShowAll(false)}>
                Focus mode
              </button>
            )}
          </span>
        )}
        <button className="btn btn-ghost h-7 shrink-0 gap-1.5 px-2" onClick={() => useSchema.getState().markSeen(cid, database)} title="Save the current schema; changes after this are highlighted" data-testid="mark-seen">
          <Check size={13} /> Mark as seen
        </button>
        <button className="icon-btn" onClick={() => flow.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })} title="Fit everything in view" aria-label="Fit to view">
          <Maximize size={14} />
        </button>
        <button className="icon-btn" onClick={() => useSchema.getState().load(cid, database, true)} title="Read the schema again" aria-label="Reload schema">
          {entry.loading || laying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <RelationMarkers />
          {big && shownTables.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6" data-testid="focus-start">
              <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow)]">
                <div className="text-[14px] font-semibold text-ink">{formatCount(candidates.length)} related tables</div>
                <p className="mt-1 text-[12.5px] text-ink-2">
                  Too many to read at once. Pick a table (or search above): it is shown with the tables it links to. Add more from the side panel.
                </p>
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
            minZoom={0.05}
            maxZoom={2}
            onlyRenderVisibleElements
            selectionKeyCode="Shift"
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeDoubleClick={(_, n) => openTable(n.id)}
            onPaneClick={() => setSearch('')}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border-strong)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => ((n.data as { table: TableView }).table.change ? 'var(--warning)' : 'var(--border-strong)')} maskColor={isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.6)'} />
          </ReactFlow>
          {laying && (
            <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 shadow-sm">
              <Loader2 size={12} className="animate-spin" /> Arranging {formatCount(tables.length)} tables…
            </div>
          )}
          {selectedNames.size > 0 && (
            <AskBar
              key={[...selectedNames].sort().join('|')}
              tables={[...selectedNames].map((n) => byName.get(n)).filter((t): t is TableView => !!t)}
              relations={relationsBetween(relations, selectedNames, selectedEdges)}
              onClear={() => {
                setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
                setEdges((es) => es.map((e) => ({ ...e, selected: false })));
              }}
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
          {!selectedNames.size && !laying && !(big && shownTables.length === 0) && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-surface/90 px-3 py-1 text-[11.5px] text-ink-3 shadow-sm">
              Click a table or a line to ask Claude about it · ⇧-drag to select several · double-click opens the data
            </div>
          )}
        </div>
        {single && byName.get(single) && (
          <TableDetails
            table={byName.get(single)!}
            relations={relations}
            onOpen={(view) => openTable(single, byName.get(single)!.kind, view)}
            onShow={focusTable}
            onExpand={big && !roots.includes(single) ? () => addRoot(single) : undefined}
            onSaveGuess={(r) => useSchema.getState().saveKey(cid, database, { table: r.from, columns: r.fromColumns, refTable: r.to, refColumns: r.toColumns })}
            onRemoveVirtual={(r) => {
              const k = virtualKeys.find((v) => v.table === r.from && v.columns.join(',') === r.fromColumns.join(','));
              if (k) useSchema.getState().deleteKey(cid, database, k.id);
            }}
          />
        )}
      </div>
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

function TableDetails({
  table: t,
  relations,
  onOpen,
  onShow,
  onExpand,
  onSaveGuess,
  onRemoveVirtual,
}: {
  table: TableView;
  relations: Relation[];
  onOpen: (view: 'data' | 'structure') => void;
  onShow: (name: string) => void;
  /** focus mode: also show the tables this one links to */
  onExpand?: () => void;
  onSaveGuess: (r: Relation) => void;
  onRemoveVirtual: (r: Relation) => void;
}) {
  const out = relations.filter((r) => r.from === t.name);
  const into = relations.filter((r) => r.to === t.name);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-bg text-[12px]" data-testid="diagram-details">
      <div className="space-y-2 border-b border-line p-3">
        <div className="mono truncate text-[13px] font-semibold text-ink" title={t.name}>
          {t.name}
        </div>
        <div className="text-ink-3">
          {t.kind === 'view' ? 'View' : 'Table'} · {t.columns.length} columns{t.rowEstimate != null ? ` · ~${formatCount(t.rowEstimate)} rows` : ''}
        </div>
        {t.comment && <div className="text-ink-2">{t.comment}</div>}
        <div className="flex gap-1.5">
          <button className="btn h-7" onClick={() => onOpen('data')}>
            Open data
          </button>
          <button className="btn btn-ghost h-7" onClick={() => onOpen('structure')}>
            Structure
          </button>
        </div>
        {onExpand && (
          <button className="btn h-7 w-full justify-center" onClick={onExpand} data-testid="expand-table">
            Show related tables
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {(out.length > 0 || into.length > 0) && (
          <div className="mb-3 space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Relations</div>
            {out.map((r) => (
              <div key={r.id} className="flex items-center gap-1">
                <button className="mono min-w-0 flex-1 truncate text-left text-link hover:underline" onClick={() => onShow(r.to)}>
                  {r.fromColumns.join(', ')} → {r.to}.{r.toColumns.join(', ')} <span className="text-ink-3">· {kindLabel(r)}{r.guessed ? ' · guessed' : r.virtual ? ' · virtual' : ''}</span>
                </button>
                <RelationAction r={r} onSaveGuess={onSaveGuess} onRemoveVirtual={onRemoveVirtual} />
              </div>
            ))}
            {into.map((r) => (
              <div key={r.id} className="flex items-center gap-1">
                <button className="mono min-w-0 flex-1 truncate text-left text-ink-2 hover:underline" onClick={() => onShow(r.from)}>
                  ← {r.from}.{r.fromColumns.join(', ')} <span className="text-ink-3">· {r.kind === 'one-to-one' ? '1:1' : '1:N'}{r.guessed ? ' · guessed' : r.virtual ? ' · virtual' : ''}</span>
                </button>
                <RelationAction r={r} onSaveGuess={onSaveGuess} onRemoveVirtual={onRemoveVirtual} />
              </div>
            ))}
          </div>
        )}
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Columns</div>
        {t.columns.map((c) => (
          <div key={c.name} className={cx('flex items-baseline gap-2 py-0.5', c.change === 'removed' && 'text-ink-3 line-through')}>
            <span className={cx('mono min-w-0 flex-1 truncate', c.primaryKey && 'font-semibold')}>{c.name}</span>
            <span className="mono max-w-[50%] truncate text-[11px] text-ink-3" title={c.dataType}>
              {c.dataType}
            </span>
            {c.change && (
              <span className={cx('shrink-0 text-[10.5px] font-semibold', c.change === 'added' ? 'text-success' : c.change === 'removed' ? 'text-danger' : 'text-warning')} title={c.detail ?? undefined}>
                {c.change}
              </span>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Save a guessed relation as a virtual foreign key, or remove a virtual one */
function RelationAction({ r, onSaveGuess, onRemoveVirtual }: { r: Relation; onSaveGuess: (r: Relation) => void; onRemoveVirtual: (r: Relation) => void }) {
  if (r.guessed)
    return (
      <button className="shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-accent hover:bg-surface-2" onClick={() => onSaveGuess(r)} title="Confirm: save as a virtual foreign key">
        Save
      </button>
    );
  if (r.virtual)
    return (
      <button className="shrink-0 rounded px-1 text-ink-3 hover:bg-surface-2 hover:text-danger" onClick={() => onRemoveVirtual(r)} title="Remove this virtual foreign key" aria-label="Remove virtual foreign key">
        <X size={11} />
      </button>
    );
  return null;
}
