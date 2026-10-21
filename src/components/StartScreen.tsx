import { installCli } from '../lib/cliInstall';
import { ArrowLeft, ChevronRight, Database, FolderInput, Loader2, Moon, MoreHorizontal, Pencil, Plus, Search, Sun, SunMoon, Trash2, Terminal } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../lib/useDismiss';
import { confirmDialog } from '../lib/api';
import { ENV_ORDER, groupByProject, projectBadge, projectColor, relativeTime, type ProjectInfo } from '../lib/projects';
import type { ConnectionConfig } from '../lib/types';
import { ENV_LABEL, MOD, cx, envColor } from '../lib/ui';
import { useApp, useProjects } from '../store/app';

export function EngineBadge({ engine, size = 36 }: { engine: ConnectionConfig['engine']; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[10px] font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.33,
        background: engine === 'mysql' ? 'color-mix(in srgb, #3b72c4 14%, transparent)' : 'color-mix(in srgb, #3f8a5c 14%, transparent)',
        color: engine === 'mysql' ? '#3b72c4' : '#3f8a5c',
      }}
      aria-label={engine === 'mysql' ? 'MySQL' : 'SQLite'}
    >
      {engine === 'mysql' ? 'My' : 'Lite'}
    </div>
  );
}

export function EnvTag({ env }: { env: ConnectionConfig['environment'] }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: envColor(env),
        background: `color-mix(in srgb, ${envColor(env)} 12%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: envColor(env) }} />
      {ENV_LABEL[env]}
    </span>
  );
}

export function connectionSubtitle(c: ConnectionConfig): string {
  if (c.engine === 'sqlite') return c.filePath || 'No file';
  const host = `${c.host || '127.0.0.1'}:${c.port || 3306}`;
  return [c.user ? `${c.user}@${host}` : host, c.database].filter(Boolean).join(' / ');
}

/** The parts of a connection worth seeing first: where it goes (host or file), then who and which database */
function connectionParts(c: ConnectionConfig): { main: string; rest: string[] } {
  if (c.engine === 'sqlite') {
    const path = c.filePath || 'No file';
    const file = path.split('/').pop() ?? path;
    return { main: file, rest: [path.slice(0, Math.max(0, path.length - file.length - 1)) || '/'] };
  }
  return { main: `${c.host || '127.0.0.1'}:${c.port || 3306}`, rest: [c.user ?? '', c.database ?? ''].filter(Boolean) };
}

export default function StartScreen({ embedded = false }: { embedded?: boolean }) {
  const connections = useApp((s) => s.connections);
  const connecting = useApp((s) => s.connecting);
  const connect = useApp((s) => s.connect);
  const setEditing = useApp((s) => s.setEditing);
  const toast = useApp((s) => s.toast);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const [query, setQuery] = useState('');
  const projects = useProjects();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connections.filter((c) => !q || `${c.name} ${projects.get(c.id)?.name ?? ''} ${connectionSubtitle(c)}`.toLowerCase().includes(q));
  }, [connections, query, projects]);
  // grouped by project: the one set on the connection, or a guess from names and databases
  const groups = useMemo(() => groupByProject(filtered.map((c) => ({ c, group: projects.get(c.id)?.name ?? null }))), [filtered, projects]);
  const lastUsed = useApp((s) => s.lastUsed);
  // the most recently opened connection gets the dark Connect button
  const recentId = useMemo(
    () =>
      Object.entries(lastUsed)
        .filter(([id]) => connections.some((c) => c.id === id))
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    [lastUsed, connections],
  );
  // folded projects, remembered on this Mac
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('rowline.closedProjects') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggleGroup = (key: string) =>
    setClosed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem('rowline.closedProjects', JSON.stringify(next));
      } catch {
        /* storage not available */
      }
      return next;
    });
  const [newProject, setNewProject] = useState(false);

  const newConnection = () =>
    setEditing({
      id: '',
      name: '',
      engine: 'mysql',
      environment: 'local',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: '',
    });

  const remove = async (c: ConnectionConfig) => {
    if (!(await confirmDialog(`Delete connection "${c.name}"? The saved password is removed too.`, { danger: true }))) return;
    try {
      // an open connection is closed first; the user may keep it open (unsaved changes), then nothing is deleted
      await useApp.getState().deleteConnection(c.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';

  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-11 shrink-0 items-center px-2" data-tauri-drag-region>
        {embedded && (
          <button className="btn btn-ghost no-drag h-7" onClick={() => useApp.getState().showLauncher(false)} data-testid="launcher-back">
            <ArrowLeft size={14} /> Back
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pb-16">
        <div className="w-full max-w-[880px] pt-10">
          <div className="mb-10 flex items-end justify-between gap-6">
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-text">
                <Database size={20} />
              </div>
              <h1 className="text-[26px] font-semibold tracking-tight text-ink">Rowline</h1>
              <p className="mt-1 text-[13.5px] text-ink-2">Open a connection to start browsing and querying.</p>
            </div>
            <div className="flex gap-2">
              {connections.length > 0 && (
                <button className="btn h-9 px-3.5" onClick={() => setNewProject(true)} data-testid="new-project">
                  New project
                </button>
              )}
              <button className="btn btn-primary h-9 px-4" onClick={newConnection}>
                <Plus size={15} /> New connection
              </button>
            </div>
          </div>
          {newProject && <NewProjectDialog connections={connections} projects={projects} onClose={() => setNewProject(false)} />}

          {connections.length > 0 && (
            <div className="relative mb-4">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11.5px] text-ink-3">{MOD}K</span>
              <input
                className="field h-10 pl-9 pr-12"
                placeholder="Search connections"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered[0]) connect(filtered[0].id);
                }}
              />
            </div>
          )}

          {connections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-strong px-8 py-16 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
                <Database size={20} />
              </div>
              <div className="text-[15px] font-medium">No connections yet</div>
              <p className="mx-auto mt-1 max-w-sm text-ink-2">Add a MySQL server or open a SQLite file. Passwords stay on this Mac, in a file only your user can read.</p>
              <button className="btn btn-primary mt-5 h-9 px-4" onClick={newConnection}>
                <Plus size={15} /> New connection
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <ProjectCard
                  key={g.group ?? ''}
                  name={g.group}
                  auto={!!g.group && g.items.every(({ c }) => !c.group?.trim())}
                  items={g.items.map(({ c }) => c)}
                  open={!!query.trim() || !closed[g.group ?? '']}
                  onToggle={() => toggleGroup(g.group ?? '')}
                  recentId={recentId}
                  connecting={connecting}
                  onConnect={connect}
                  onEdit={(c) => setEditing({ ...c })}
                  onDelete={remove}
                  onDropConnection={(id) => useApp.getState().setProject([id], g.group)}
                  showUngroupedHint={!g.group && groups.length > 1}
                />
              ))}
              {filtered.length === 0 && <div className="rounded-xl border border-dashed border-line-strong p-10 text-center text-ink-3">No connection matches “{query}”.</div>}
            </div>
          )}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-between border-t border-line px-4 text-[11.5px] text-ink-3">
        <span>MySQL · SQLite</span>
        <div className="flex-1" />
        <button className="btn btn-ghost h-7" onClick={installCli} title="Put the rowline command in ~/.local/bin: agents can run read-only queries on open connections" data-testid="install-cli">
          <Terminal size={14} /> Command line
        </button>
        <button className="btn btn-ghost h-7" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}`}>
          <ThemeIcon size={14} /> {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
        </button>
      </div>
    </div>
  );
}

function ProjectCard({
  name,
  auto,
  items,
  open,
  onToggle,
  recentId,
  connecting,
  onConnect,
  onEdit,
  onDelete,
  onDropConnection,
  showUngroupedHint,
}: {
  /** null: connections without a project */
  name: string | null;
  auto: boolean;
  items: ConnectionConfig[];
  open: boolean;
  onToggle: () => void;
  recentId: string | null;
  connecting: string | null;
  onConnect: (id: string) => void;
  onEdit: (c: ConnectionConfig) => void;
  onDelete: (c: ConnectionConfig) => void;
  onDropConnection: (id: string) => void;
  showUngroupedHint: boolean;
}) {
  const lastUsed = useApp((s) => s.lastUsed);
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);
  const [over, setOver] = useState(false);
  const sorted = [...items].sort((a, b) => (ENV_ORDER[a.environment] ?? 9) - (ENV_ORDER[b.environment] ?? 9) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const c of items) counts.set(c.environment, (counts.get(c.environment) ?? 0) + 1);
  const color = name ? projectColor(name) : null;

  const rename = async () => {
    setMenu(null);
    const next = window.prompt('Project name', name ?? '');
    if (next === null || !next.trim() || next.trim() === name) return;
    await useApp.getState().setProject(
      items.map((c) => c.id),
      next.trim(),
    );
  };

  return (
    <section
      className={cx('overflow-hidden rounded-xl border bg-surface transition-shadow', over ? 'border-accent shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-line')}
      data-testid="project-group"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-rowline-connection')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData('application/x-rowline-connection');
        if (id && !items.some((c) => c.id === id)) onDropConnection(id);
      }}
    >
      <div className={cx('flex cursor-default items-center gap-3 bg-surface-2/50 px-4 py-2.5 hover:bg-surface-2', open && 'border-b border-line')} onClick={onToggle} data-testid="project-header">
        <ChevronRight size={13} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        {name && color ? (
          <span
            className={cx('flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[11px] font-bold', auto && 'border border-dashed')}
            style={auto ? { borderColor: color, color } : { background: color, color: '#fff' }}
            title={auto ? 'Guessed from the connection names or database' : undefined}
          >
            {projectBadge(name)}
          </span>
        ) : (
          <span className="h-[26px] w-[26px] shrink-0 rounded-md border-[1.5px] border-dashed border-line-strong" />
        )}
        <span className="truncate text-[14px] font-semibold text-ink">{name ?? 'No project'}</span>
        <span className="shrink-0 text-[12.5px] text-ink-3">
          {items.length} connection{items.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {[...counts.entries()]
            .sort((a, b) => (ENV_ORDER[a[0]] ?? 9) - (ENV_ORDER[b[0]] ?? 9))
            .map(([env, n]) => (
              <span key={env} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: envColor(env as ConnectionConfig['environment']) }} />
                {n} {ENV_LABEL[env as ConnectionConfig['environment']].toLowerCase()}
              </span>
            ))}
        </div>
        {name && (
          <div className="relative">
            <button
              className="icon-btn h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                setMenu('__project');
              }}
              title="Project settings"
              aria-label="Project settings"
            >
              <MoreHorizontal size={15} />
            </button>
            {menu === '__project' && (
              <div
                ref={menuRef}
                className="fade-in absolute right-0 top-8 z-20 w-52 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]"
                onClick={(e) => e.stopPropagation()}
              >
                {auto && (
                  <button
                    className={MENU_ITEM}
                    onClick={() => (
                      setMenu(null),
                      useApp.getState().setProject(
                        items.map((c) => c.id),
                        name,
                      )
                    )}
                  >
                    Keep as project
                  </button>
                )}
                <button className={MENU_ITEM} onClick={rename}>
                  <Pencil size={13} /> Rename…
                </button>
                {!auto && (
                  <button
                    className={MENU_ITEM}
                    onClick={() => (
                      setMenu(null),
                      useApp.getState().setProject(
                        items.map((c) => c.id),
                        null,
                      )
                    )}
                  >
                    Ungroup connections
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {open && (
        <div>
          {sorted.map((c, i) => {
            const parts = connectionParts(c);
            const recent = c.id === recentId;
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-rowline-connection', c.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                data-testid="connection-card"
                className={cx(
                  'group relative grid cursor-default grid-cols-[32px_minmax(0,1fr)_auto_auto] items-center gap-3.5 py-3 pl-11 pr-4 hover:bg-surface-2/50',
                  i > 0 && 'border-t border-line',
                  connecting === c.id && 'opacity-70',
                )}
                style={color ? { boxShadow: `inset 3px 0 0 ${auto ? `${color}80` : color}` } : undefined}
                onDoubleClick={() => onConnect(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && onConnect(c.id)}
              >
                <EngineBadge engine={c.engine} size={32} />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-ink">{c.name}</span>
                    <EnvTag env={c.environment} />
                  </div>
                  <div className="mono mt-0.5 flex min-w-0 gap-1.5 text-[12px] text-ink-3" title={connectionSubtitle(c)}>
                    <span className="max-w-[70%] shrink-0 truncate text-ink-2">{parts.main}</span>
                    {parts.rest.map((r) => (
                      <span key={r} className="flex min-w-0 gap-1.5">
                        <span className="shrink-0">·</span>
                        <span className="truncate">{r}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <span className="w-20 text-right text-[12px] text-ink-3" title={lastUsed[c.id] ? new Date(lastUsed[c.id]).toLocaleString() : 'Not opened yet'}>
                  {relativeTime(lastUsed[c.id])}
                </span>
                {connecting === c.id ? (
                  <Loader2 size={16} className="mx-8 animate-spin text-ink-3" />
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      className="icon-btn opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(c.id);
                      }}
                      aria-label="More"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    <button className={cx('btn w-24 justify-center', recent && '!border-ink !bg-ink !text-bg hover:!opacity-90')} onClick={() => onConnect(c.id)}>
                      Connect
                    </button>
                  </div>
                )}
                {menu === c.id && (
                  <div ref={menuRef} className="fade-in absolute right-28 top-11 z-20 w-40 rounded-lg border border-line-strong bg-surface-2 p-1 shadow-[var(--shadow)]">
                    <button className={MENU_ITEM} onClick={() => (setMenu(null), onEdit(c))}>
                      <Pencil size={14} /> Edit
                    </button>
                    <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-danger hover:bg-danger-soft" onClick={() => (setMenu(null), onDelete(c))}>
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {showUngroupedHint && <div className="border-t border-line py-2.5 pl-11 pr-4 text-[12.5px] text-ink-3">Drag a connection onto a project to group it.</div>}
        </div>
      )}
    </section>
  );
}

const MENU_ITEM = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3';

/** New project: a name and the connections to put in it */
function NewProjectDialog({ connections, projects, onClose }: { connections: ConnectionConfig[]; projects: Map<string, ProjectInfo>; onClose: () => void }) {
  const [name, setName] = useState('');
  // connections without a project are picked by default
  const [picked, setPicked] = useState<Set<string>>(() => new Set(connections.filter((c) => !projects.has(c.id)).map((c) => c.id)));
  const save = async () => {
    if (!name.trim() || !picked.size) return;
    await useApp.getState().setProject([...picked], name.trim());
    onClose();
  };
  return (
    <div className="fade-in mb-4 rounded-xl border border-line bg-surface p-4" data-testid="new-project-dialog" onClick={(e) => e.stopPropagation()}>
      <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
        <FolderInput size={15} /> New project
      </div>
      <input className="field mb-3" placeholder="Project name, e.g. Sollit" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
      <div className="label mb-1.5">Connections in it</div>
      <div className="max-h-60 space-y-0.5 overflow-y-auto">
        {connections.map((c) => (
          <label key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2">
            <input
              type="checkbox"
              checked={picked.has(c.id)}
              onChange={(e) =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (e.target.checked) n.add(c.id);
                  else n.delete(c.id);
                  return n;
                })
              }
            />
            <span className="truncate">{c.name}</span>
            <EnvTag env={c.environment} />
            {projects.get(c.id) && <span className="ml-auto truncate text-[11.5px] text-ink-3">now in {projects.get(c.id)!.name}</span>}
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!name.trim() || !picked.size}>
          Create project
        </button>
      </div>
    </div>
  );
}
