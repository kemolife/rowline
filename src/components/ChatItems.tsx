import { AlertCircle, Check, Database, ExternalLink, Loader2, ShieldAlert, X, Code2 } from 'lucide-react';
import Markdown from 'react-markdown';
import { TOOL_LABEL, type ApprovalItem, type ChatItem, type ToolItem } from '../lib/chat';
import { cx } from '../lib/ui';
import { useApp } from '../store/app';

const TOOL_TITLE: Record<string, string> = { run_select: 'Query', list_tables: 'List tables', describe_table: 'Describe table', list_connections: 'Connections' };

export default function ChatItems({ items, onAnswer }: { items: ChatItem[]; onAnswer: (requestId: string, allow: boolean) => void }) {
  return (
    <>
      {items.map((it) => {
        switch (it.type) {
          case 'user':
            return (
              <div key={it.id} className="selectable ml-8 self-end whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                {it.text}
              </div>
            );
          case 'assistant':
            return (
              <div key={it.id} className="chat-md selectable text-[13px] leading-relaxed">
                <Markdown components={{ a: ({ children }) => <span className="underline decoration-dotted">{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{it.text}</Markdown>
                {it.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />}
              </div>
            );
          case 'tool':
            return <ToolCard key={it.id} item={it} />;
          case 'approval':
            return <ApprovalCard key={it.id} item={it} onAnswer={onAnswer} />;
          case 'notice':
            return (
              <div key={it.id} className={cx('selectable flex gap-2 rounded-lg px-3 py-2 text-[12.5px]', it.tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink-2')}>
                {it.tone === 'error' && <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                <span>{it.text}</span>
              </div>
            );
        }
      })}
    </>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const connections = useApp((s) => s.connections);
  const name = connections.find((c) => c.id === item.connection)?.name ?? item.connection;
  const canOpen = item.tool === 'run_select' && item.sql && item.connection && item.status === 'done';
  const openInGrid = () => {
    const s = useApp.getState();
    if (!item.connection || !item.sql || !s.workspaces[item.connection]) return;
    s.switchTo(item.connection);
    s.openQuery(item.connection, item.sql, { autoRun: true, database: item.database });
  };
  const openInEditor = () => {
    const s = useApp.getState();
    if (!item.connection || !item.sql || !s.workspaces[item.connection]) return;
    s.switchTo(item.connection);
    s.openQuery(item.connection, item.sql, { database: item.database });
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line text-[12px]" data-testid="tool-card">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface-2/60 px-2.5 py-1.5 text-ink-3">
        {item.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : item.status === 'error' ? <X size={12} className="text-danger" /> : <Database size={12} />}
        <span className="font-medium text-ink-2">{TOOL_TITLE[item.tool] ?? item.tool}</span>
        {name && <span className="truncate">· {name}</span>}
        <span className="ml-auto shrink-0 tabular-nums">
          {item.status === 'running' ? TOOL_LABEL[item.tool] ?? '' : item.rows != null ? `${item.rows}${item.truncated ? '+' : ''} rows` : ''}
          {item.elapsedMs != null && item.status !== 'running' ? ` · ${item.elapsedMs} ms` : ''}
        </span>
      </div>
      {item.sql && <pre className="selectable mono max-h-40 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-[11.5px] text-ink-2">{item.sql}</pre>}
      {item.error && <div className="selectable border-t border-line px-2.5 py-1.5 text-danger">{item.error}</div>}
      {canOpen && (
        <div className="flex border-t border-line">
          <button className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-accent hover:bg-surface-2" onClick={openInGrid} title="Open a SQL tab with this query and run it">
            <ExternalLink size={12} /> Open in grid
          </button>
          <button className="flex flex-1 items-center gap-1.5 border-l border-line px-2.5 py-1.5 text-left text-ink-2 hover:bg-surface-2" onClick={openInEditor} title="Open a SQL tab with this query, without running it">
            <Code2 size={12} /> Open in SQL tab
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, onAnswer }: { item: ApprovalItem; onAnswer: (requestId: string, allow: boolean) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--env-prod)_45%,var(--border))] text-[12px]" data-testid="approval-card">
      <div className="flex items-center gap-1.5 bg-[color-mix(in_srgb,var(--env-prod)_10%,transparent)] px-2.5 py-1.5 font-medium text-[var(--env-prod)]">
        <ShieldAlert size={13} /> Production · {item.connectionName}
      </div>
      <pre className="selectable mono max-h-48 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-[11.5px]">{item.sql}</pre>
      <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
        {item.answer === 'pending' ? (
          <>
            <span className="text-ink-3">Run this read-only query?</span>
            <button className="btn ml-auto h-7" onClick={() => onAnswer(item.requestId, false)}>
              Deny
            </button>
            <button className="btn btn-primary h-7" onClick={() => onAnswer(item.requestId, true)} data-testid="approve-query">
              Run
            </button>
          </>
        ) : (
          <span className={cx('flex items-center gap-1.5', item.answer === 'allowed' ? 'text-success' : 'text-ink-3')}>
            {item.answer === 'allowed' ? <Check size={13} /> : <X size={13} />} {item.answer === 'allowed' ? 'You allowed this query' : 'You denied this query'}
          </span>
        )}
      </div>
    </div>
  );
}
