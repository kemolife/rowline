import { CheckCircle2, FolderOpen, Loader2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, pickFolder, pickSqliteFile } from '../lib/api';
import { effectiveClaudeAccess, type ClaudeAccess, type ConnectionInput, type Engine, type Environment, type TlsMode } from '../lib/types';
import { ENV_LABEL, cx, envColor } from '../lib/ui';
import { useApp } from '../store/app';
import { EngineBadge } from './StartScreen';

const ENVS: Environment[] = ['local', 'dev', 'staging', 'prod'];
const TLS_MODES: { mode: TlsMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Plain connection, for local servers.' },
  { mode: 'required', label: 'Required', hint: 'Encrypted. The certificate is not checked (works with AWS RDS and private CAs).' },
  { mode: 'verify', label: 'Verify', hint: 'Encrypted, and the server certificate must be trusted by macOS.' },
];
const CLAUDE_ACCESS: { value: ClaudeAccess; label: string; hint: string }[] = [
  { value: 'data', label: 'Schema + data', hint: 'Claude sees tables and can run read-only SELECT queries.' },
  { value: 'schema', label: 'Schema only', hint: 'Claude sees tables and columns, but no rows.' },
  { value: 'off', label: 'Off', hint: 'Claude can’t see this connection.' },
];

export default function ConnectionForm() {
  const editing = useApp((s) => s.editing)!;
  const setEditing = useApp((s) => s.setEditing);
  const loadConnections = useApp((s) => s.loadConnections);
  const connect = useApp((s) => s.connect);
  const isNew = !editing.id;
  const [form, setForm] = useState<ConnectionInput>(editing);
  const [passwordTouched, setPasswordTouched] = useState(isNew);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setEditing(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setEditing]);

  const set = (patch: Partial<ConnectionInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };

  const payload = (): ConnectionInput => ({
    ...form,
    name: form.name.trim() || defaultName(form),
    port: form.engine === 'mysql' ? Number(form.port) || 3306 : null,
    // Claude off: no folder for Claude to read
    projectFolder: effectiveClaudeAccess(form) === 'off' ? null : form.projectFolder?.trim() || null,
    password: form.engine === 'mysql' && passwordTouched ? form.password ?? '' : undefined,
  });

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const info = await api.testConnection(payload());
      setResult({ ok: true, text: `Connected · ${info.version}` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async (andConnect: boolean) => {
    setBusy('save');
    try {
      const saved = await api.saveConnection(payload());
      await loadConnections();
      setEditing(null);
      if (!isNew) await useApp.getState().applySavedConnection(saved, passwordTouched);
      if (andConnect) await connect(saved.id);
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const browse = async () => {
    const path = await pickSqliteFile();
    if (path) set({ filePath: path, name: form.name || fileName(path) });
  };

  const switchEngine = (engine: Engine) =>
    set(engine === 'mysql' ? { engine, host: form.host || '127.0.0.1', port: form.port || 3306, user: form.user || 'root' } : { engine });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]" onMouseDown={() => setEditing(null)}>
      <form
        className="fade-in w-full max-w-[520px] rounded-2xl border border-line bg-surface shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-[14px] font-semibold">{isNew ? 'New connection' : 'Edit connection'}</div>
          <button type="button" className="icon-btn" onClick={() => setEditing(null)} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-2">
            {(['mysql', 'sqlite'] as Engine[]).map((e) => (
              <button
                type="button"
                key={e}
                onClick={() => switchEngine(e)}
                className={cx(
                  'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  form.engine === e ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
                )}
              >
                <EngineBadge engine={e} size={28} />
                <div>
                  <div className="text-[13px] font-medium">{e === 'mysql' ? 'MySQL' : 'SQLite'}</div>
                  <div className="text-[11.5px] text-ink-3">{e === 'mysql' ? 'Server connection' : 'Local database file'}</div>
                </div>
              </button>
            ))}
          </div>

          <label className="block space-y-1.5">
            <span className="label">Name</span>
            <input className="field" value={form.name} placeholder={defaultName(form)} onChange={(e) => set({ name: e.target.value })} autoFocus />
          </label>

          <div className="space-y-1.5">
            <span className="label">Environment</span>
            <div className="flex gap-1.5">
              {ENVS.map((env) => (
                <button
                  type="button"
                  key={env}
                  onClick={() => set({ environment: env })}
                  className={cx('flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[12px] font-medium', form.environment === env ? 'border-transparent' : 'border-line text-ink-2 hover:bg-surface-2')}
                  style={form.environment === env ? { background: `color-mix(in srgb, ${envColor(env)} 14%, transparent)`, color: envColor(env) } : undefined}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: envColor(env) }} />
                  {ENV_LABEL[env]}
                </button>
              ))}
            </div>
            {form.environment === 'prod' && <p className="text-[11.5px] text-ink-3">Statements that change data ask for confirmation before they run.</p>}
          </div>

          {form.engine === 'mysql' ? (
            <>
              <div className="grid grid-cols-[1fr_96px] gap-2">
                <label className="block space-y-1.5">
                  <span className="label">Host</span>
                  <input className="field field-mono" value={form.host ?? ''} onChange={(e) => set({ host: e.target.value })} />
                </label>
                <label className="block space-y-1.5">
                  <span className="label">Port</span>
                  <input className="field field-mono" inputMode="numeric" value={form.port ?? ''} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || null })} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1.5">
                  <span className="label">User</span>
                  <input className="field field-mono" value={form.user ?? ''} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                </label>
                <label className="block space-y-1.5">
                  <span className="label">Password</span>
                  <input
                    className="field field-mono"
                    type="password"
                    value={passwordTouched ? form.password ?? '' : ''}
                    placeholder={passwordTouched ? '' : 'Saved'}
                    onChange={(e) => {
                      setPasswordTouched(true);
                      set({ password: e.target.value });
                    }}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <label className="block space-y-1.5">
                <span className="label">Database <span className="font-normal text-ink-3">(optional)</span></span>
                <input className="field field-mono" value={form.database ?? ''} onChange={(e) => set({ database: e.target.value })} />
              </label>
              <div className="space-y-1.5">
                <span className="label">TLS</span>
                <div className="flex rounded-lg bg-surface-2 p-0.5">
                  {TLS_MODES.map((t) => (
                    <button
                      type="button"
                      key={t.mode}
                      onClick={() => set({ tls: t.mode })}
                      className={cx('h-7 flex-1 rounded-md text-[12px] font-medium', (form.tls ?? 'off') === t.mode ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11.5px] text-ink-3">{TLS_MODES.find((t) => t.mode === (form.tls ?? 'off'))?.hint}</p>
              </div>
            </>
          ) : (
            <label className="block space-y-1.5">
              <span className="label">Database file</span>
              <div className="flex gap-2">
                <input className="field field-mono" value={form.filePath ?? ''} placeholder="/path/to/database.sqlite" onChange={(e) => set({ filePath: e.target.value })} />
                <button type="button" className="btn h-8 shrink-0" onClick={browse}>
                  <FolderOpen size={14} /> Browse
                </button>
              </div>
            </label>
          )}

          <div className="space-y-1.5 border-t border-line pt-4">
            <span className="label">Claude access</span>
            <div className="flex rounded-lg bg-surface-2 p-0.5">
              {CLAUDE_ACCESS.map((a) => (
                <button
                  type="button"
                  key={a.value}
                  onClick={() => set({ claudeAccess: a.value })}
                  className={cx('h-7 flex-1 rounded-md text-[12px] font-medium', effectiveClaudeAccess(form) === a.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
                  data-testid={`claude-access-${a.value}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-ink-3">{CLAUDE_ACCESS.find((a) => a.value === effectiveClaudeAccess(form))?.hint}</p>
          </div>
          {effectiveClaudeAccess(form) !== 'off' && (
            <label className="block space-y-1.5">
              <span className="label">Project folder <span className="font-normal text-ink-3">(optional)</span></span>
              <div className="flex gap-2">
                <input className="field field-mono" value={form.projectFolder ?? ''} placeholder="/path/to/your/app" onChange={(e) => set({ projectFolder: e.target.value })} />
                <button
                  type="button"
                  className="btn h-8 shrink-0"
                  onClick={async () => {
                    const folder = await pickFolder();
                    if (folder) set({ projectFolder: folder });
                  }}
                >
                  <FolderOpen size={14} /> Choose
                </button>
              </div>
              <p className="text-[11.5px] text-ink-3">Claude can read files in this folder. It can’t change them.</p>
            </label>
          )}

          {result && (
            <div className={cx('selectable flex items-start gap-2 rounded-lg px-3 py-2 text-[12px]', result.ok ? 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-success' : 'bg-danger-soft text-danger')}>
              {result.ok ? <CheckCircle2 size={15} className="mt-px shrink-0" /> : <XCircle size={15} className="mt-px shrink-0" />}
              <span className="break-words">{result.text}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <button type="button" className="btn" onClick={test} disabled={!!busy}>
            {busy === 'test' && <Loader2 size={14} className="animate-spin" />} Test
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={() => save(false)} disabled={!!busy}>
              Save
            </button>
            <button type="submit" className="btn btn-primary" disabled={!!busy}>
              {busy === 'save' && <Loader2 size={14} className="animate-spin" />} Save & connect
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function fileName(path: string) {
  return path.split('/').pop() || path;
}

function defaultName(f: ConnectionInput) {
  if (f.engine === 'sqlite') return f.filePath ? fileName(f.filePath) : 'SQLite file';
  return [f.host || '127.0.0.1', f.database].filter(Boolean).join(' / ');
}
