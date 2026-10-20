import { Code2, LogOut, PanelLeft, Search, Sparkles } from 'lucide-react';
import { ENV_LABEL, MOD, cx, envColor } from '../lib/ui';
import { useApp, useProjects, wsActiveTab } from '../store/app';
import ProjectBadge from './ProjectBadge';
import { useWs, useWsActions } from '../store/workspace';
import BackupMenu from './BackupMenu';

export default function Header({ trafficLightSpace }: { trafficLightSpace: boolean }) {
  const session = useWs((w) => w.session);
  const tab = useWs(wsActiveTab);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const toggleClaude = useApp((s) => s.toggleClaude);
  const claudeOpen = useApp((s) => s.claudeOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const setEditing = useApp((s) => s.setEditing);
  const savedConfig = useApp((s) => s.connections.find((c) => c.id === session.connectionId));
  const { openQuery, disconnect } = useWsActions();
  const env = session.config.environment;
  const object = tab?.kind === 'table' ? tab.table : tab?.kind === 'query' ? tab.title : tab?.kind === 'diagram' ? 'Relations' : null;
  const database = session.config.engine === 'sqlite' ? session.info.currentDatabase : session.database;
  // SQLite connections are often named after their file; don't show the same text twice
  const project = useProjects().get(session.connectionId) ?? null;
  const parts = [session.info.version, session.config.name, database !== session.config.name ? database : null, object];

  return (
    <header className="drag flex h-11 shrink-0 items-center gap-1 border-b border-line bg-bg pr-2" style={{ paddingLeft: trafficLightSpace ? 32 : 8 }} data-tauri-drag-region>
      <button className="icon-btn no-drag" onClick={toggleSidebar} title={`Toggle sidebar (${MOD}B)`} aria-label="Toggle sidebar">
        <PanelLeft size={16} />
      </button>
      <button className="btn btn-ghost no-drag h-7 gap-1.5 px-2 text-ink-2" onClick={() => openQuery()} title={`New SQL query (${MOD}T)`} data-testid="new-sql">
        <Code2 size={14} /> SQL
      </button>

      <div className="flex min-w-0 flex-1 justify-center px-3" data-tauri-drag-region>
        <button
          type="button"
          onClick={() => setEditing({ ...(savedConfig ?? session.config) })}
          className="no-drag mono flex h-[26px] min-w-0 max-w-[760px] flex-1 items-center gap-2 rounded-lg border px-2.5 text-left text-[11.5px] hover:brightness-110"
          style={{
            borderColor: `color-mix(in srgb, ${envColor(env)} 35%, var(--border))`,
            background: `color-mix(in srgb, ${envColor(env)} ${env === 'prod' ? 12 : 7}%, var(--surface))`,
          }}
          data-testid="connection-pill"
          title={`${ENV_LABEL[env]} · ${session.info.version} — click to edit the connection`}
        >
          <span className="shrink-0 rounded px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide text-white" style={{ background: envColor(env) }}>
            {ENV_LABEL[env]}
          </span>
          {project && <ProjectBadge project={project} full className="px-1.5 py-[3px] text-[10.5px]" />}
          <span className="truncate text-ink-2">{parts.filter(Boolean).join('  ·  ')}</span>
        </button>
      </div>

      <button className="btn btn-ghost no-drag h-7 text-ink-3" onClick={() => setPaletteOpen(true)} title="Search tables and actions">
        <Search size={14} /> <span className="kbd">{MOD} K</span>
      </button>
      <button className={cx('icon-btn no-drag', claudeOpen && 'text-accent')} onClick={toggleClaude} title={`Claude (${MOD}L)`} aria-label="Toggle Claude panel" data-testid="toggle-claude">
        <Sparkles size={15} />
      </button>
      <BackupMenu />
      <button className="icon-btn no-drag" onClick={disconnect} title="Disconnect" aria-label="Disconnect">
        <LogOut size={15} />
      </button>
    </header>
  );
}
