import { Check, Loader2, Network, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { nameMatcher, type Relation } from '../lib/diagram';
import { diffSchema, hasChanges, summaryText, type TableView } from '../lib/schemaDiff';
import { cx, formatCount, shortCount } from '../lib/ui';
import { tableKey } from '../store/app';
import { useDiagramView, type DiagramOutline } from '../store/diagramView';
import { emptySchema, useSchema } from '../store/schema';
import { useWs, useWsActions } from '../store/workspace';

/**
 * Sidebar "Diagram". With a diagram tab open: an outline of it (find a table, the selected table
 * with its relations, tables by group). Otherwise: a button to open it and the schema changes.
 */
export default function DiagramPane() {
  const tabId = useWs((w) => (w.tabs.find((t) => t.id === w.activeTabId)?.kind === 'diagram' ? w.activeTabId : null));
  const outline = useDiagramView((s) => (tabId ? s.outlines[tabId] : undefined));
  return tabId && outline ? <Outline tabId={tabId} outline={outline} /> : <Start />;
}

function useSchemaChanges() {
  const session = useWs((w) => w.session);
  const cid = session.connectionId;
  const database = session.config.engine === 'mysql' ? session.database : null;
  const entry = useSchema((s) => s.entries[tableKey(cid, database)]) ?? emptySchema;
  useEffect(() => {
    if (session.config.engine === 'sqlite' || database) useSchema.getState().load(cid, database);
  }, [cid, database, session.config.engine]);
  const last = entry.snapshots[entry.snapshots.length - 1] ?? null;
  const diff = useMemo(() => (entry.live && last ? diffSchema(last.tables, entry.live) : null), [entry.live, last]);
  return { session, cid, database, entry, last, diff, markSeen: () => useSchema.getState().markSeen(cid, database) };
}

function Start() {
  const { openDiagram } = useWsActions();
  const { session, database, entry, last, diff, markSeen } = useSchemaChanges();
  const changed = diff ? diff.tables.filter((t) => t.change) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2.5" data-testid="diagram-pane">
      <button className="btn btn-primary h-8 justify-center" onClick={() => openDiagram()} data-testid="open-diagram" disabled={session.config.engine === 'mysql' && !database}>
        <Network size={14} /> Open relation diagram
      </button>
      <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-ink-3">Tables and their foreign keys. Click a table to see its relations; select several to ask Claude about them.</p>

      <div className="mt-4 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Schema changes</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1.5 text-[12px]">
        {entry.loading && !entry.live ? (
          <div className="flex items-center gap-2 text-ink-3">
            <Loader2 size={13} className="animate-spin" /> Reading the schema…
          </div>
        ) : entry.error ? (
          <div className="selectable text-danger">{entry.error}</div>
        ) : !last ? (
          <div className="space-y-2 text-ink-3">
            <p>Not tracked yet. Mark the current schema as seen; later changes (new tables, columns, keys, for example after a migration) show here and on the diagram.</p>
            <button className="btn h-7" onClick={markSeen} disabled={!entry.live}>
              <Check size={13} /> Mark as seen
            </button>
          </div>
        ) : diff && hasChanges(diff.summary) ? (
          <div className="space-y-2">
            <div className="text-ink-2">
              Since {new Date(last.takenAt).toLocaleString()}: <span className="font-medium text-warning">{summaryText(diff.summary)}</span>
            </div>
            <div className="space-y-0.5">
              {changed.map((t) => (
                <button key={t.name} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2" onClick={() => openDiagram(t.name)} title="Show on the diagram">
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', t.change === 'added' ? 'bg-success' : t.change === 'removed' ? 'bg-danger' : 'bg-warning')} />
                  <span className={cx('mono min-w-0 flex-1 truncate', t.change === 'removed' && 'line-through')}>{t.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{t.change}</span>
                </button>
              ))}
            </div>
            <button className="btn h-7" onClick={markSeen}>
              <Check size={13} /> Mark as seen
            </button>
          </div>
        ) : (
          <div className="text-ink-3">No changes since {new Date(last.takenAt).toLocaleString()}.</div>
        )}
      </div>
    </div>
  );
}

function Outline({ tabId, outline }: { tabId: string; outline: DiagramOutline }) {
  const { tables, allTables, relations, groups, colors, pinned, expandable, namePattern, actions } = outline;
  const query = useDiagramView((s) => s.query[tabId] ?? '');
  const hover = useDiagramView((s) => s.hover[tabId] ?? null);
  const { setQuery, setHover } = useDiagramView.getState();
  const { entry, last, diff, markSeen } = useSchemaChanges();
  const byName = useMemo(() => new Map(allTables.map((t) => [t.name, t])), [allTables]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => nameMatcher(q), [q]);
  const shown = useMemo(() => new Set(tables.map((t) => t.name)), [tables]);
  // search also finds tables that are not on the diagram; picking one shows it
  const hiddenMatches = useMemo(() => (q ? allTables.filter((t) => !shown.has(t.name) && matches(t.name)).slice(0, 20) : []), [q, allTables, shown]);
  const firstMatch = q ? (tables.find((t) => matches(t.name)) ?? hiddenMatches[0])?.name : undefined;
  const pinnedTable = pinned ? byName.get(pinned) : undefined;
  // the search as a filter: `tbl_*` puts every tbl_ table on the diagram
  const filterCount = useMemo(() => (q ? allTables.filter((t) => nameMatcher(q)(t.name)).length : 0), [q, allTables]);

  const row = (name: string, color: string | null) => {
    const t = byName.get(name);
    const match = !q || matches(name);
    return (
      <button
        key={name}
        className={cx('flex w-full items-center gap-2 rounded-md py-1 pl-[21px] pr-2 text-left hover:bg-surface-3', name === pinned && 'bg-surface-3', name === hover && name !== pinned && 'bg-surface-2')}
        style={{ opacity: match ? 1 : 0.35 }}
        onClick={() => actions.pin(name)}
        onDoubleClick={() => actions.open(name, 'data')}
        onMouseEnter={() => setHover(tabId, name)}
        onMouseLeave={() => setHover(tabId, null)}
        title={color ? undefined : 'Not on the diagram: click to show it'}
      >
        <span className={cx('mono min-w-0 flex-1 truncate text-[12px]', name === pinned ? 'font-bold text-ink' : color ? 'text-ink' : 'text-ink-3')}>{name}</span>
        {t?.rowEstimate != null && <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{shortCount(t.rowEstimate)}</span>}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diagram-outline">
      <div className="px-2.5 pt-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            className="field h-[30px] pl-8 text-[12.5px]"
            placeholder="Find a table on the diagram"
            value={query}
            onChange={(e) => setQuery(tabId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstMatch) actions.pin(firstMatch);
              if (e.key === 'Escape') setQuery(tabId, '');
            }}
            data-testid="diagram-search"
          />
        </div>
        {q && filterCount > 0 && q !== namePattern?.toLowerCase() && (
          <button
            className="mt-1.5 w-full rounded-md px-1 text-left text-[11.5px] text-link hover:underline"
            onClick={() => {
              actions.filterByName(query);
              setQuery(tabId, '');
            }}
            title="Show only these tables on the diagram (* matches any text: tbl_*, *_log)"
            data-testid="filter-by-name"
          >
            Show only {formatCount(filterCount)} matching table{filterCount === 1 ? '' : 's'} on the diagram
          </button>
        )}
      </div>

      {pinnedTable && (
        <FocusCard
          table={pinnedTable}
          relations={relations}
          onClose={() => actions.pin(null)}
          onShow={actions.pin}
          onOpen={(view) => actions.open(pinnedTable.name, view)}
          onAsk={actions.ask}
          onExpand={expandable.has(pinnedTable.name) ? () => actions.expand(pinnedTable.name) : undefined}
          onSaveGuess={actions.saveGuess}
          onRemoveVirtual={actions.removeVirtual}
        />
      )}

      <div className="mt-2.5 min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3">
        {groups.map((g, i) => (
          <div key={g.hub ?? '~other'} className="space-y-px">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold tracking-[0.03em] text-ink-3">
              <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: colors.get(g.tables[0]) }} />
              <span className="min-w-0 flex-1 truncate uppercase">{g.hub ?? (i === 0 ? 'Tables' : 'Other')}</span>
              <span className="font-normal">{g.tables.length}</span>
            </div>
            {g.tables.map((name) => row(name, colors.get(name) ?? null))}
          </div>
        ))}
        {hiddenMatches.length > 0 && (
          <div className="space-y-px">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.03em] text-ink-3">Not on the diagram</div>
            {hiddenMatches.map((t) => row(t.name, null))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-[12px]" data-testid="diagram-changes">
        <span className="min-w-0 flex-1 truncate text-ink-2" title={last ? `Compared with the schema marked as seen on ${new Date(last.takenAt).toLocaleString()}` : undefined}>
          {entry.loading && !entry.live ? (
            'Reading the schema…'
          ) : !last ? (
            'Schema changes not tracked'
          ) : diff && hasChanges(diff.summary) ? (
            <span className="font-medium text-warning">{summaryText(diff.summary)}</span>
          ) : (
            'No schema changes'
          )}
        </span>
        <button className="btn h-7 shrink-0 px-2.5" onClick={markSeen} disabled={!entry.live} title="Save the current schema so later changes are highlighted" data-testid="mark-seen">
          <Check size={13} /> Mark as seen
        </button>
      </div>
    </div>
  );
}

/** The selected table: its size, what it links to, and what to do with it */
function FocusCard({
  table: t,
  relations,
  onClose,
  onShow,
  onOpen,
  onAsk,
  onExpand,
  onSaveGuess,
  onRemoveVirtual,
}: {
  table: TableView;
  relations: Relation[];
  onClose: () => void;
  onShow: (name: string) => void;
  onOpen: (view: 'data' | 'structure') => void;
  onAsk: () => void;
  onExpand?: () => void;
  onSaveGuess: (r: Relation) => void;
  onRemoveVirtual: (r: Relation) => void;
}) {
  const out = relations.filter((r) => r.from === t.name);
  const into = relations.filter((r) => r.to === t.name && r.from !== t.name);
  const link = (r: Relation, dir: 'out' | 'in') => {
    const other = dir === 'out' ? r.to : r.from;
    const cols = dir === 'out' ? r.toColumns : r.fromColumns;
    return (
      <div key={`${dir}:${r.id}`} className="group flex items-center gap-1.5 rounded-[5px] px-1 py-[3px] hover:bg-surface-2">
        <button className="mono flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11.5px]" onClick={() => onShow(other)} title={`${r.from}.${r.fromColumns.join(', ')} → ${r.to}.${r.toColumns.join(', ')}`}>
          <span className="w-3.5 shrink-0 text-center text-accent">{dir === 'out' ? '→' : '←'}</span>
          <span className="shrink-0 font-semibold text-ink">{other}</span>
          <span className="min-w-0 flex-1 truncate text-ink-3">.{cols.join(', ')}</span>
        </button>
        {r.guessed && (
          <>
            <span className="shrink-0 rounded-[3px] border border-dashed border-line-strong px-1 text-[10px] text-ink-3 group-hover:hidden">guessed</span>
            <button className="hidden shrink-0 rounded px-1 text-[10.5px] font-semibold text-accent hover:bg-surface-3 group-hover:block" onClick={() => onSaveGuess(r)} title="Confirm: save as a virtual foreign key">
              Save
            </button>
          </>
        )}
        {r.virtual && (
          <>
            <span className="shrink-0 rounded-[3px] border border-dotted border-line-strong px-1 text-[10px] text-ink-3 group-hover:hidden">virtual</span>
            <button className="hidden shrink-0 rounded px-1 text-ink-3 hover:bg-surface-3 hover:text-danger group-hover:block" onClick={() => onRemoveVirtual(r)} title="Remove this virtual foreign key" aria-label="Remove virtual foreign key">
              <X size={11} />
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="mx-2.5 mt-2.5 flex flex-col gap-2.5 rounded-[9px] border border-line bg-surface p-3" data-testid="diagram-details">
      <div className="flex items-baseline gap-2">
        <span className="mono min-w-0 flex-1 truncate text-[13px] font-bold text-ink" title={t.name}>
          {t.name}
        </span>
        <button className="shrink-0 px-1 text-ink-3 hover:text-ink" onClick={onClose} aria-label="Clear the selection">
          <X size={13} />
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-2">
        {t.rowEstimate != null && (
          <span title={`~${formatCount(t.rowEstimate)} rows`}>
            <b className="font-semibold text-ink">{shortCount(t.rowEstimate)}</b> rows
          </span>
        )}
        <span>
          <b className="font-semibold text-ink">{out.length}</b> references
        </span>
        <span>
          <b className="font-semibold text-ink">{into.length}</b> referenced by
        </span>
      </div>
      {t.comment && <div className="text-[12px] text-ink-2">{t.comment}</div>}
      {(out.length > 0 || into.length > 0) && (
        <div className="-mx-1 flex max-h-[220px] flex-col overflow-y-auto">
          {out.map((r) => link(r, 'out'))}
          {into.map((r) => link(r, 'in'))}
        </div>
      )}
      <div className="flex gap-1.5">
        <button className="h-7 flex-1 rounded-md bg-ink text-[12px] font-semibold text-bg hover:opacity-90" onClick={() => onOpen('data')}>
          Open data
        </button>
        <button className="btn h-7 flex-1 justify-center" onClick={onAsk} data-testid="ask-claude">
          <Sparkles size={12} className="text-accent" /> Ask Claude
        </button>
      </div>
      <div className="-mt-1 flex gap-3 text-[11.5px]">
        <button className="text-link hover:underline" onClick={() => onOpen('structure')}>
          Structure
        </button>
        {onExpand && (
          <button className="text-link hover:underline" onClick={onExpand} data-testid="expand-table">
            Show related tables
          </button>
        )}
      </div>
    </div>
  );
}
