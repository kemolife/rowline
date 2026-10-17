import type { ChatEvent } from './types';

export interface AssistantItem {
  type: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
}

export interface ToolItem {
  type: 'tool';
  id: string;
  callId: string;
  tool: string;
  connection: string | null;
  /** MySQL database the tool used (null for SQLite) */
  database: string | null;
  sql: string | null;
  status: 'running' | 'done' | 'error';
  rows: number | null;
  truncated: boolean;
  elapsedMs: number | null;
  error: string | null;
}

export interface ApprovalItem {
  type: 'approval';
  id: string;
  requestId: string;
  connection: string;
  connectionName: string;
  sql: string;
  answer: 'pending' | 'allowed' | 'denied';
}

export type ChatItem =
  | { type: 'user'; id: string; text: string }
  | AssistantItem
  | ToolItem
  | ApprovalItem
  | { type: 'notice'; id: string; tone: 'error' | 'info'; text: string; errorKind?: string };

export interface ChatView {
  items: ChatItem[];
  /** Claude is working on an answer */
  busy: boolean;
  /** short status line ("Reading models/user.ts") */
  activity: string | null;
  lastSeq: number;
}

export const emptyChat: ChatView = { items: [], busy: false, activity: null, lastSeq: 0 };

export const TOOL_LABEL: Record<string, string> = {
  run_select: 'Running query',
  list_tables: 'Listing tables',
  describe_table: 'Reading table structure',
  list_connections: 'Checking connections',
};

export function noticeText(kind: string, message: string): string {
  if (kind === 'login') return 'Claude Code is not logged in. Run `claude` in Terminal, then `/login`, and try again.';
  if (kind === 'limit') return `Your Claude plan limit is reached. ${message}`;
  return message;
}

/** Folds new backend events into the chat view (pure; events with seq ≤ lastSeq are ignored). */
export function applyEvents(view: ChatView, events: ChatEvent[]): ChatView {
  let items = [...view.items];
  let { busy, activity, lastSeq } = view;
  const streamingIndex = () => {
    const last = items[items.length - 1];
    return last?.type === 'assistant' && last.streaming ? items.length - 1 : -1;
  };
  const finishStreaming = () => {
    items = items.map((it) => (it.type === 'assistant' && it.streaming ? { ...it, streaming: false } : it));
  };
  /** The turn ended: nothing waits for an answer or runs any more. */
  const closeOpenCards = (stopped: boolean) => {
    items = items.map((it) => {
      if (it.type === 'approval' && it.answer === 'pending') return { ...it, answer: 'denied' };
      if (it.type === 'tool' && it.status === 'running') return { ...it, status: 'error', error: stopped ? 'Stopped' : 'Not finished' };
      return it;
    });
  };

  for (const e of events) {
    if (e.seq <= lastSeq) continue;
    lastSeq = e.seq;
    const id = `e${e.seq}`;
    switch (e.kind) {
      case 'user':
        items.push({ type: 'user', id, text: e.text });
        busy = true;
        activity = null;
        break;
      case 'text_delta': {
        const i = streamingIndex();
        if (i >= 0) items[i] = { ...(items[i] as AssistantItem), text: (items[i] as AssistantItem).text + e.text };
        else items.push({ type: 'assistant', id, text: e.text, streaming: true });
        activity = null;
        break;
      }
      case 'text': {
        const i = streamingIndex();
        if (i >= 0) items[i] = { ...(items[i] as AssistantItem), text: e.text, streaming: false };
        else items.push({ type: 'assistant', id, text: e.text, streaming: false });
        break;
      }
      case 'activity':
        activity = e.label;
        break;
      case 'tool_call':
        finishStreaming();
        items.push({ type: 'tool', id, callId: e.callId, tool: e.tool, connection: e.connection, database: e.database, sql: e.sql, status: 'running', rows: null, truncated: false, elapsedMs: null, error: null });
        activity = TOOL_LABEL[e.tool] ?? `Using ${e.tool}`;
        break;
      case 'tool_result':
        items = items.map((it) =>
          it.type === 'tool' && it.callId === e.callId ? { ...it, status: e.error ? 'error' : 'done', rows: e.rows, truncated: e.truncated, elapsedMs: e.elapsedMs, error: e.error } : it,
        );
        activity = null;
        break;
      case 'approval':
        items.push({ type: 'approval', id, requestId: e.requestId, connection: e.connection, connectionName: e.connectionName, sql: e.sql, answer: 'pending' });
        activity = 'Waiting for your approval';
        break;
      case 'approval_answered':
        items = items.map((it) => (it.type === 'approval' && it.requestId === e.requestId ? { ...it, answer: e.allowed ? 'allowed' : 'denied' } : it));
        activity = null;
        break;
      case 'done':
        finishStreaming();
        closeOpenCards(false);
        busy = false;
        activity = null;
        break;
      case 'stopped':
        finishStreaming();
        closeOpenCards(true);
        if (busy) items.push({ type: 'notice', id, tone: 'info', text: 'Stopped.' });
        busy = false;
        activity = null;
        break;
      case 'error':
        finishStreaming();
        closeOpenCards(false);
        items.push({ type: 'notice', id, tone: 'error', text: noticeText(e.errorKind, e.message), errorKind: e.errorKind });
        busy = false;
        activity = null;
        break;
    }
  }
  return { items, busy, activity, lastSeq };
}
