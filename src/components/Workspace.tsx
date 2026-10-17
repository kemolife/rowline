import { useEffect, useRef } from 'react';
import { isTauri } from '../lib/api';
import { isMac, matchKey } from '../lib/ui';
import { useApp } from '../store/app';
import { useConnectionId, useWs, useWsActions } from '../store/workspace';
import ClaudePanel from './ClaudePanel';
import DataTab from './DataTab';
import DiagramTab from './DiagramTab';
import Header from './Header';
import QueryTabView from './QueryTabView';
import Sidebar from './Sidebar';
import TabBar from './TabBar';

export default function Workspace({ active }: { active: boolean }) {
  const cid = useConnectionId();
  const tabs = useWs((w) => w.tabs);
  const activeTabId = useWs((w) => w.activeTabId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const claudeOpen = useApp((s) => s.claudeOpen);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // already handled by a focused element (CodeMirror uses ⌘L to select a line)
      if (!activeRef.current || e.defaultPrevented) return;
      const s = useApp.getState();
      const w = s.workspaces[cid];
      if (!w) return;
      if (matchKey(e, 'mod+k') || matchKey(e, 'mod+p')) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (matchKey(e, 'mod+t')) {
        e.preventDefault();
        s.openQuery(cid);
      } else if (matchKey(e, 'mod+w')) {
        e.preventDefault();
        if (w.activeTabId) s.closeTab(cid, w.activeTabId);
      } else if (matchKey(e, 'mod+b')) {
        e.preventDefault();
        s.toggleSidebar();
      } else if (matchKey(e, 'mod+shift+]') || (e.ctrlKey && e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        cycleTab(cid, 1);
      } else if (matchKey(e, 'mod+shift+[') || (e.ctrlKey && e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        cycleTab(cid, -1);
      }
    };
    // ⌘L toggles the Claude panel everywhere: caught in the capture phase, before the SQL editor
    // (CodeMirror) can use it to select a line
    const onToggleClaude = (e: KeyboardEvent) => {
      if (!activeRef.current || !matchKey(e, 'mod+l')) return;
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().toggleClaude();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onToggleClaude, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onToggleClaude, true);
    };
  }, [cid]);

  const prod = useWs((w) => w.session.config.environment === 'prod');

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Production: a red frame around the whole window, so it is never mistaken for dev */}
      {prod && active && <div className="pointer-events-none fixed inset-0 z-[900] shadow-[inset_0_0_0_3px_var(--env-prod)]" data-testid="prod-frame" />}
      <Header trafficLightSpace={isTauri && isMac} />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          <TabBar />
          <div className="relative min-h-0 flex-1">
            {tabs.length === 0 && <EmptyWorkspace />}
            {/* tabs stay mounted so their state (pages, edits, editor) survives switching */}
            {tabs.map((t) => (
              <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeTabId ? 'flex' : 'none' }}>
                {t.kind === 'table' ? (
                  <DataTab tab={t} active={active && t.id === activeTabId} />
                ) : t.kind === 'diagram' ? (
                  <DiagramTab tab={t} active={active && t.id === activeTabId} />
                ) : (
                  <QueryTabView tab={t} active={active && t.id === activeTabId} />
                )}
              </div>
            ))}
          </div>
        </main>
        {claudeOpen && <ClaudePanel />}
      </div>
    </div>
  );
}

function cycleTab(cid: string, dir: number) {
  const s = useApp.getState();
  const w = s.workspaces[cid];
  if (!w?.tabs.length) return;
  const idx = w.tabs.findIndex((t) => t.id === w.activeTabId);
  s.setActiveTab(cid, w.tabs[(idx + dir + w.tabs.length) % w.tabs.length].id);
}

function EmptyWorkspace() {
  const { openQuery } = useWsActions();
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const mod = isMac ? '⌘' : 'Ctrl';
  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-72 space-y-1.5 text-[12.5px]">
        <div className="mb-3 text-[13px] font-medium text-ink-2">Get started</div>
        {[
          ['Open a table', 'Click it in the sidebar'],
          ['Quick open', `${mod} K`, () => setPaletteOpen(true)],
          ['New query', `${mod} T`, () => openQuery()],
          ['Toggle sidebar', `${mod} B`],
        ].map(([label, hint, action]) => (
          <button
            key={label as string}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
            onClick={action as (() => void) | undefined}
            disabled={!action}
          >
            <span>{label as string}</span>
            <span className="kbd">{hint as string}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
