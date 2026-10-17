import { Plus, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { effectiveClaudeAccess, type ConnectionConfig } from '../lib/types';
import { useDismiss } from '../lib/useDismiss';
import { envColor } from '../lib/ui';
import { useApp } from '../store/app';
import { useChat } from '../store/chat';

/** one shared empty list, so the store selector returns a stable value */
const NO_EXTRA: string[] = [];

function Chip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const w = useApp((s) => s.workspaces[id]);
  const saved = useApp((s) => s.connections.find((c) => c.id === id));
  if (!w) return null;
  const c = saved ?? w.session.config;
  const db = c.engine === 'mysql' ? w.session.database : null;
  return (
    <span className="flex h-6 max-w-[220px] items-center gap-1 rounded-full px-2 text-[11.5px]" style={{ background: `color-mix(in srgb, ${envColor(c.environment)} 14%, transparent)`, color: envColor(c.environment) }}>
      <span className="truncate">@ {c.name}{db ? ` · ${db}` : ''}</span>
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${c.name}`} className="shrink-0 opacity-70 hover:opacity-100">
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export default function ConnectionChips({ cid }: { cid: string }) {
  const extra = useChat((s) => s.chats[cid]?.extra ?? NO_EXTRA);
  const setExtra = useChat((s) => s.setExtra);
  const openOrder = useApp((s) => s.openOrder);
  const workspaces = useApp((s) => s.workspaces);
  const connections = useApp((s) => s.connections);
  /** the saved config (fresh after an edit), else the copy from connect time */
  const configOf = (id: string): ConnectionConfig | undefined => connections.find((c) => c.id === id) ?? workspaces[id]?.session.config;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, close, open);
  const candidates = openOrder.filter((id) => id !== cid && !extra.includes(id) && workspaces[id] && effectiveClaudeAccess(configOf(id)!) !== 'off');

  return (
    // the dismiss area includes the "+ connection" button, so a second click on it closes the menu
    <div ref={ref} className="relative flex flex-wrap items-center gap-1" data-testid="connection-chips">
      <Chip id={cid} />
      {extra.filter((id) => workspaces[id]).map((id) => (
        <Chip key={id} id={id} onRemove={() => setExtra(cid, extra.filter((e) => e !== id))} />
      ))}
      {candidates.length > 0 && (
        <button className="flex h-6 items-center gap-0.5 rounded-full border border-line px-2 text-[11.5px] text-ink-3 hover:text-ink" onClick={() => setOpen(!open)} aria-label="Add connection">
          <Plus size={11} /> connection
        </button>
      )}
      {open && (
        <div className="fade-in absolute bottom-8 left-0 z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
          {candidates.map((id) => (
            <button
              key={id}
              className="flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3"
              onClick={() => {
                setExtra(cid, [...extra, id]);
                setOpen(false);
              }}
            >
              {configOf(id)?.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
