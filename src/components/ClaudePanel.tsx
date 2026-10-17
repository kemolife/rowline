import { ArrowUp, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { emptyChat } from '../lib/chat';
import { ResizeHandle, usePanelWidth } from '../lib/panelWidth';
import { effectiveClaudeAccess } from '../lib/types';
import { MOD } from '../lib/ui';
import { useApp } from '../store/app';
import { useChat } from '../store/chat';
import { useConnectionId, useWs } from '../store/workspace';
import ChatItems from './ChatItems';
import ConnectionChips from './ConnectionChips';


export default function ClaudePanel() {
  const cid = useConnectionId();
  const session = useWs((w) => w.session);
  // the saved config, fresh after an edit (session.config is the copy from connect time)
  const config = useApp((s) => s.connections.find((c) => c.id === cid)) ?? session.config;
  const view = useChat((s) => s.chats[cid]?.view ?? emptyChat);
  const status = useChat((s) => s.status);
  const noticeSeen = useChat((s) => s.noticeSeen);
  const toggleClaude = useApp((s) => s.toggleClaude);
  const [text, setText] = useState('');
  const width = usePanelWidth('claude');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const access = effectiveClaudeAccess(config);

  useEffect(() => {
    if (!status) useChat.getState().checkStatus();
    inputRef.current?.focus();
  }, [status]);

  // text sent here from elsewhere ("Ask Claude" on a result or the diagram)
  const draft = useChat((s) => s.drafts[cid]);
  useEffect(() => {
    if (draft == null) return;
    const d = useChat.getState().takeDraft(cid);
    if (d == null) return;
    setText(d);
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [draft, cid]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.items]);

  const submit = (value = text) => {
    const t = value.trim();
    if (!t || view.busy) return;
    setText('');
    useChat.getState().send(cid, t);
  };


  const tables = session.objects.filter((o) => o.kind === 'table').slice(0, 2).map((o) => o.name);
  const examples = tables.length
    ? [`What is stored in ${tables[0]}? Show 5 example rows.`, `How many rows does ${tables[0]} have, grouped by a useful column?`, tables[1] ? `How are ${tables[0]} and ${tables[1]} related?` : `Which tables reference ${tables[0]}?`]
    : ['Which tables are in this database?'];

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-bg" style={{ width }} data-testid="claude-panel">
      <ResizeHandle panel="claude" edge="left" />
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles size={14} className="text-accent" />
        <span className="text-[13px] font-medium">Claude</span>
        <span className="kbd ml-1">{MOD} L</span>
        <button className="icon-btn ml-auto h-7 w-7" onClick={() => useChat.getState().newChat(cid)} title="New chat" aria-label="New chat">
          <RotateCcw size={13} />
        </button>
        <button className="icon-btn h-7 w-7" onClick={toggleClaude} title={`Close (${MOD}L)`} aria-label="Close Claude panel">
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {!noticeSeen && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
            Claude sees the tables, rows and files it reads here. They are sent to Anthropic. Change this per connection in its settings.{' '}
            <button className="font-medium text-accent" onClick={() => useChat.getState().dismissNotice()}>
              Got it
            </button>
          </div>
        )}
        {status && !status.found ? (
          <div className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-ink-2" data-testid="claude-missing">
            <div className="mb-1 font-medium text-ink">Claude Code is not installed</div>
            Install Claude Code, run <code className="mono">claude</code> once in Terminal and log in. Then open this panel again.
          </div>
        ) : access === 'off' ? (
          <div className="text-[12.5px] text-ink-3">Claude is off for this connection. Change it in the connection settings.</div>
        ) : view.items.length === 0 ? (
          <div className="mt-6 space-y-2 text-[12.5px]">
            <div className="text-ink-2">Ask about the data in {config.name}.{access === 'schema' ? ' Claude sees tables and columns only.' : ''}</div>
            {examples.map((q) => (
              <button key={q} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        ) : (
          <ChatItems items={view.items} onAnswer={(requestId, allow) => useChat.getState().answer(cid, requestId, allow)} />
        )}
      </div>

      {view.busy && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3 text-[12px] text-ink-3">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="truncate">{view.activity ?? 'Thinking…'}</span>
          <button className="btn ml-auto h-6 px-2" onClick={() => useChat.getState().stop(cid)} data-testid="stop-claude">
            <Square size={10} className="fill-current" /> Stop
          </button>
        </div>
      )}

      {access !== 'off' && status?.found !== false && (
        <div className="shrink-0 border-t border-line p-2.5">
          <div className="rounded-xl border border-line-strong bg-surface p-2 focus-within:border-accent">
            <ConnectionChips cid={cid} />
            <div className="mt-1.5 flex items-end gap-2">
              <textarea
                ref={inputRef}
                className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-ink-3"
                rows={1}
                placeholder="Ask about your data…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                data-testid="claude-input"
              />
              <button className="btn btn-primary h-8 w-8 shrink-0 justify-center p-0" onClick={() => submit()} disabled={view.busy || !text.trim()} aria-label="Send">
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
