import { Code2, Eye, Network, Plus, Table2, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOD, cx } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useWs, useWsActions } from '../store/workspace';

export default function TabBar() {
  const tabs = useWs((w) => w.tabs);
  const activeTabId = useWs((w) => w.activeTabId);
  const dirty = useWs((w) => w.dirtyTabs);
  const { setActiveTab, closeTab, closeTabs, openQuery } = useWsActions();
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);

  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-bg px-1.5">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const Icon = t.kind === 'query' ? Code2 : t.kind === 'diagram' ? Network : t.objectKind === 'view' ? Eye : Table2;
        const title = t.kind === 'query' ? t.title : t.kind === 'diagram' ? `Relations${t.database ? ` · ${t.database}` : ''}` : t.table;
        const unsaved = (dirty[t.id] ?? 0) > 0;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            data-testid="tab"
            className={cx(
              'group relative flex h-[30px] min-w-[120px] max-w-[220px] cursor-default items-center gap-2 rounded-t-lg border border-b-0 px-3 text-[12.5px]',
              active ? 'border-line bg-surface text-ink' : 'border-transparent text-ink-2 hover:bg-surface-2/70',
            )}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            onMouseDown={(e) => {
              if (e.button === 2) return;
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              } else setActiveTab(t.id);
            }}
          >
            {active && <span className="absolute inset-x-0 -bottom-px h-px bg-surface" />}
            <Icon size={13} className={cx('shrink-0', active ? 'text-accent' : 'text-ink-3')} />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <button
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(t.id)}
              aria-label={`Close ${title}`}
            >
              {unsaved ? <span className="h-2 w-2 rounded-full bg-accent group-hover:hidden" /> : null}
              <X size={12} className={cx(unsaved && 'hidden group-hover:block')} />
            </button>
          </div>
        );
      })}
      <button className="icon-btn mb-0.5 h-7 w-7 shrink-0" onClick={() => openQuery()} title={`New query (${MOD}T)`} aria-label="New query tab">
        <Plus size={15} />
      </button>

      {menu &&
        createPortal(
          (() => {
            const idx = tabs.findIndex((t) => t.id === menu.id);
            const others = tabs.filter((t) => t.id !== menu.id).map((t) => t.id);
            const right = tabs.slice(idx + 1).map((t) => t.id);
            const items: [string, () => void, boolean, string?][] = [
              ['Close', () => closeTab(menu.id), false, `${MOD}W`],
              ['Close others', () => closeTabs(others), !others.length],
              ['Close tabs to the right', () => closeTabs(right), !right.length],
              ['Close all', () => closeTabs(tabs.map((t) => t.id)), false],
            ];
            return (
              <div
                ref={menuRef}
                className="fade-in fixed z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]"
                style={{ left: Math.min(menu.x, window.innerWidth - 232), top: menu.y }}
                data-testid="tab-menu"
              >
                {items.map(([label, run, disabled, keys], i) => (
                  <div key={label}>
                    {i === 1 && <div className="my-1 h-px bg-line" />}
                    <button
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
                      disabled={disabled}
                      onClick={() => {
                        setMenu(null);
                        run();
                      }}
                    >
                      {label}
                      {keys && <span className="ml-auto text-[11px] text-ink-3">{keys}</span>}
                    </button>
                  </div>
                ))}
              </div>
            );
          })(),
          document.getElementById('portal') ?? document.body,
        )}
    </div>
  );
}
