import { useEffect } from 'react';
import { applyThemeAttribute, useApp } from './store/app';
import { closeLeftoverChats } from './store/chat';
import { ConnectionScope } from './store/workspace';
import CommandPalette from './components/CommandPalette';
import ConnectionForm from './components/ConnectionForm';
import ConnectionRail from './components/ConnectionRail';
import StartScreen from './components/StartScreen';
import Toasts from './components/Toasts';
import Workspace from './components/Workspace';

export default function App() {
  const theme = useApp((s) => s.theme);
  const openOrder = useApp((s) => s.openOrder);
  const activeId = useApp((s) => s.activeConnectionId);
  const launcherOpen = useApp((s) => s.launcherOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const editing = useApp((s) => s.editing);
  const loadConnections = useApp((s) => s.loadConnections);

  useEffect(() => {
    applyThemeAttribute(theme);
  }, [theme]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // after a reload the old page's chats would keep their Claude Code processes running
  useEffect(() => {
    void closeLeftoverChats();
  }, []);

  // ⌘1…⌘9 switch connections; Esc closes the connection list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const id = s.openOrder[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          s.switchTo(id);
        }
      } else if (e.key === 'Escape' && s.launcherOpen && !s.editing) {
        s.showLauncher(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (openOrder.length === 0) {
    return (
      <>
        <StartScreen />
        {editing && <ConnectionForm />}
        <Toasts />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full">
        <ConnectionRail />
        <div className="relative flex min-w-0 flex-1">
          {/* every open connection stays mounted, so its tabs, filters and scroll survive a switch */}
          {openOrder.map((id) => {
            const visible = id === activeId && !launcherOpen;
            return (
              <div key={id} className="absolute inset-0 flex" style={{ display: visible ? 'flex' : 'none' }}>
                <ConnectionScope id={id}>
                  <Workspace active={visible} />
                </ConnectionScope>
              </div>
            );
          })}
          {launcherOpen && (
            <div className="absolute inset-0 flex">
              <StartScreen embedded />
            </div>
          )}
        </div>
      </div>
      {paletteOpen && activeId && (
        <ConnectionScope id={activeId}>
          <CommandPalette />
        </ConnectionScope>
      )}
      {editing && <ConnectionForm />}
      <Toasts />
    </>
  );
}
