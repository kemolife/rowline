import { LogOut, Pencil, Plus, Type } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { isTauri } from '../lib/api';
import { ENV_LABEL, MOD, cx, envColor, isMac } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useApp } from '../store/app';

export function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function ConnectionRail() {
  const openOrder = useApp((s) => s.openOrder);
  const workspaces = useApp((s) => s.workspaces);
  const connections = useApp((s) => s.connections);
  const activeId = useApp((s) => s.activeConnectionId);
  const launcherOpen = useApp((s) => s.launcherOpen);
  const connecting = useApp((s) => s.connecting);
  /** `rename` holds the text while the name is being edited in the menu */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; rename?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);
  /** the saved config (fresh after an edit or rename), else the copy from connect time */
  const configOf = (id: string) => connections.find((c) => c.id === id) ?? workspaces[id]?.session.config;

  const saveRename = () => {
    if (!menu || menu.rename === undefined) return;
    useApp.getState().renameConnection(menu.id, menu.rename);
    setMenu(null);
  };

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3';

  return (
    <nav className="drag flex w-[52px] shrink-0 flex-col items-center gap-2 border-r border-line bg-bg pb-3" style={{ paddingTop: isTauri && isMac ? 44 : 10 }} data-tauri-drag-region data-testid="connection-rail">
      {openOrder.map((id, i) => {
        const c = configOf(id);
        if (!c || !workspaces[id]) return null;
        const color = envColor(c.environment);
        const active = id === activeId && !launcherOpen;
        return (
          <button
            key={id}
            className={cx('group no-drag relative flex h-9 w-9 items-center justify-center rounded-[10px] text-[12px] font-semibold transition-shadow', active && 'shadow-[0_0_0_2px_var(--accent)]')}
            style={{ background: `color-mix(in srgb, ${color} ${active ? 22 : 14}%, transparent)`, color }}
            onClick={() => useApp.getState().switchTo(id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id });
            }}
            aria-label={`Switch to ${c.name}`}
            aria-current={active}
            data-testid="rail-item"
          >
            {initials(c.name)}
            {/* green dot: connected (every connection in the rail is open) */}
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-success" />
            {/* name label on hover */}
            <span className={cx('pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[12px] font-medium text-ink shadow-[var(--shadow)]', !menu && 'group-hover:block')}>
              {c.name}
              <span className="ml-1.5 font-normal text-ink-3">
                {ENV_LABEL[c.environment]} · connected
                {i < 9 ? ` · ${MOD}${i + 1}` : ''}
              </span>
            </span>
          </button>
        );
      })}
      <button
        className={cx('no-drag flex h-9 w-9 items-center justify-center rounded-[10px] border border-dashed border-line-strong text-ink-3 hover:text-ink', launcherOpen && 'border-accent text-accent')}
        onClick={() => useApp.getState().showLauncher(!launcherOpen)}
        title="Open another connection"
        aria-label="Open another connection"
        data-testid="rail-add"
      >
        {connecting ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Plus size={16} />}
      </button>

      {menu && (
        <div ref={menuRef} className="fade-in fixed z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]" style={{ left: menu.x, top: menu.y }} data-testid="rail-menu">
          {menu.rename !== undefined ? (
            <form
              className="flex gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                saveRename();
              }}
            >
              <input
                className="field h-7 text-[12.5px]"
                value={menu.rename}
                onChange={(e) => setMenu({ ...menu, rename: e.target.value })}
                onKeyDown={(e) => e.key === 'Escape' && setMenu(null)}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Connection name"
              />
              <button type="submit" className="btn h-7 px-2" disabled={!menu.rename.trim()}>
                Save
              </button>
            </form>
          ) : (
            <>
              <button
                className={item}
                onClick={() => {
                  const c = configOf(menu.id);
                  setMenu(null);
                  if (c) useApp.getState().setEditing({ ...c });
                }}
              >
                <Pencil size={13} /> Edit connection…
              </button>
              <button className={item} onClick={() => setMenu({ ...menu, rename: configOf(menu.id)?.name ?? '' })}>
                <Type size={13} /> Rename…
              </button>
              <div className="my-1 h-px bg-line" />
              <button
                className={item}
                onClick={() => {
                  setMenu(null);
                  useApp.getState().disconnect(menu.id);
                }}
              >
                <LogOut size={13} /> Disconnect
              </button>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
