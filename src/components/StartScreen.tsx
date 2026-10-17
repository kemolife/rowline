import { ArrowLeft, Database, Loader2, Moon, MoreHorizontal, Pencil, Plus, Search, Sun, SunMoon, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { confirmDialog } from '../lib/api';
import type { ConnectionConfig } from '../lib/types';
import { ENV_LABEL, cx, envColor } from '../lib/ui';
import { useApp } from '../store/app';

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
      style={{ color: envColor(env), background: `color-mix(in srgb, ${envColor(env)} 12%, transparent)` }}
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

export default function StartScreen({ embedded = false }: { embedded?: boolean }) {
  const connections = useApp((s) => s.connections);
  const connecting = useApp((s) => s.connecting);
  const connect = useApp((s) => s.connect);
  const setEditing = useApp((s) => s.setEditing);
  const toast = useApp((s) => s.toast);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connections.filter((c) => !q || `${c.name} ${connectionSubtitle(c)}`.toLowerCase().includes(q));
  }, [connections, query]);

  const newConnection = () =>
    setEditing({ id: '', name: '', engine: 'mysql', environment: 'local', host: '127.0.0.1', port: 3306, user: 'root', database: '' });

  const remove = async (c: ConnectionConfig) => {
    setMenu(null);
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
    <div className="flex h-full flex-col" onClick={() => setMenu(null)}>
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
            <button className="btn btn-primary h-9 px-4" onClick={newConnection}>
              <Plus size={15} /> New connection
            </button>
          </div>

          {connections.length > 0 && (
            <div className="relative mb-4">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                className="field h-10 pl-9"
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
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {filtered.map((c) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  data-testid="connection-card"
                  className={cx(
                    'group relative flex cursor-default items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 transition-colors',
                    'hover:border-line-strong hover:bg-surface-2/50',
                    connecting === c.id && 'opacity-70',
                  )}
                  onDoubleClick={() => connect(c.id)}
                  onKeyDown={(e) => e.key === 'Enter' && connect(c.id)}
                >
                  <EngineBadge engine={c.engine} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink">{c.name}</span>
                      <EnvTag env={c.environment} />
                    </div>
                    <div className="mono mt-0.5 truncate text-[11.5px] text-ink-3">{connectionSubtitle(c)}</div>
                  </div>
                  {connecting === c.id ? (
                    <Loader2 size={16} className="animate-spin text-ink-3" />
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        className="icon-btn opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu(menu === c.id ? null : c.id);
                        }}
                        aria-label="More"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      <button className="btn" onClick={() => connect(c.id)}>
                        Connect
                      </button>
                    </div>
                  )}
                  {menu === c.id && (
                    <div className="fade-in absolute right-24 top-11 z-20 w-40 rounded-lg border border-line-strong bg-surface-2 p-1 shadow-[var(--shadow)]">
                      <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3" onClick={() => { setMenu(null); setEditing({ ...c }); }}>
                        <Pencil size={14} /> Edit
                      </button>
                      <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-danger hover:bg-danger-soft" onClick={() => remove(c)}>
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {filtered.length === 0 && <div className="col-span-full py-10 text-center text-ink-3">No connection matches “{query}”.</div>}
            </div>
          )}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-between border-t border-line px-4 text-[11.5px] text-ink-3">
        <span>MySQL · SQLite</span>
        <button className="btn btn-ghost h-7" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}`}>
          <ThemeIcon size={14} /> {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
        </button>
      </div>
    </div>
  );
}
