import { describe, expect, it } from 'vitest';
import { applyEvents, emptyChat } from './chat';
import type { ChatEvent } from './types';

let seq = 0;
type NoSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;
const ev = (e: NoSeq<ChatEvent>) => ({ ...e, seq: ++seq }) as ChatEvent;

describe('applyEvents', () => {
  it('streams text, then replaces it with the final text', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'user', text: 'hi' }), ev({ kind: 'text_delta', text: 'Hel' }), ev({ kind: 'text_delta', text: 'lo' })]);
    expect(v.busy).toBe(true);
    expect(v.items[1]).toMatchObject({ type: 'assistant', text: 'Hello', streaming: true });
    v = applyEvents(v, [ev({ kind: 'text', text: 'Hello!' }), ev({ kind: 'done', durationMs: 5, costUsd: null })]);
    expect(v.items[1]).toMatchObject({ type: 'assistant', text: 'Hello!', streaming: false });
    expect(v.busy).toBe(false);
  });

  it('turns tool calls into cards and updates them', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'tool_call', callId: 'c1', tool: 'run_select', connection: 'x', database: 'shop', sql: 'SELECT 1' })]);
    expect(v.items[0]).toMatchObject({ type: 'tool', status: 'running', database: 'shop' });
    expect(v.activity).toBe('Running query');
    v = applyEvents(v, [ev({ kind: 'tool_result', callId: 'c1', rows: 3, truncated: false, elapsedMs: 4, error: null })]);
    expect(v.items[0]).toMatchObject({ status: 'done', rows: 3 });
    v = applyEvents(v, [ev({ kind: 'tool_call', callId: 'c2', tool: 'run_select', connection: 'x', database: null, sql: 'DELETE' }), ev({ kind: 'tool_result', callId: 'c2', rows: null, truncated: false, elapsedMs: 1, error: 'Only read-only' })]);
    expect(v.items[1]).toMatchObject({ status: 'error', error: 'Only read-only' });
  });

  it('tracks approvals', () => {
    let v = applyEvents(emptyChat, [ev({ kind: 'approval', requestId: 'r1', connection: 'p', connectionName: 'Prod', sql: 'SELECT 1' })]);
    expect(v.items[0]).toMatchObject({ type: 'approval', answer: 'pending' });
    v = applyEvents(v, [ev({ kind: 'approval_answered', requestId: 'r1', allowed: false })]);
    expect(v.items[0]).toMatchObject({ answer: 'denied' });
  });

  it('shows errors with the fix and ignores repeated events', () => {
    const e = ev({ kind: 'error', errorKind: 'login', message: 'Invalid API key' });
    let v = applyEvents(emptyChat, [e]);
    v = applyEvents(v, [e]);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ type: 'notice', tone: 'error' });
    expect((v.items[0] as { text: string }).text).toContain('/login');
  });

  it('Stop closes a pending approval and a running tool', () => {
    let v = applyEvents(emptyChat, [
      ev({ kind: 'user', text: 'x' }),
      ev({ kind: 'tool_call', callId: 'c1', tool: 'run_select', connection: 'p', database: null, sql: 'SELECT 1' }),
      ev({ kind: 'approval', requestId: 'r1', connection: 'p', connectionName: 'Prod', sql: 'SELECT 1' }),
    ]);
    v = applyEvents(v, [ev({ kind: 'stopped' })]);
    expect(v.items.find((i) => i.type === 'approval')).toMatchObject({ answer: 'denied' });
    expect(v.items.find((i) => i.type === 'tool')).toMatchObject({ status: 'error', error: 'Stopped' });
    expect(v.busy).toBe(false);
    expect(v.activity).toBeNull();
  });

  it('done and error close open cards but keep finished ones', () => {
    const start = [
      ev({ kind: 'user', text: 'x' }),
      ev({ kind: 'tool_call', callId: 'ok', tool: 'list_tables', connection: 'p', database: null, sql: null }),
      ev({ kind: 'tool_result', callId: 'ok', rows: 2, truncated: false, elapsedMs: 3, error: null }),
      ev({ kind: 'approval', requestId: 'r0', connection: 'p', connectionName: 'Prod', sql: 'SELECT 0' }),
      ev({ kind: 'approval_answered', requestId: 'r0', allowed: true }),
      ev({ kind: 'tool_call', callId: 'open', tool: 'run_select', connection: 'p', database: null, sql: 'SELECT 1' }),
      ev({ kind: 'approval', requestId: 'r1', connection: 'p', connectionName: 'Prod', sql: 'SELECT 1' }),
    ];
    const base = applyEvents(emptyChat, start);
    for (const end of [ev({ kind: 'done', durationMs: 1, costUsd: null }), ev({ kind: 'error', errorKind: 'exited', message: 'gone' })]) {
      const v = applyEvents(base, [end]);
      const byId = (pred: (i: (typeof v.items)[number]) => boolean) => v.items.find(pred);
      expect(byId((i) => i.type === 'tool' && i.callId === 'ok')).toMatchObject({ status: 'done', rows: 2, error: null });
      expect(byId((i) => i.type === 'tool' && i.callId === 'open')).toMatchObject({ status: 'error', error: 'Not finished' });
      expect(byId((i) => i.type === 'approval' && i.requestId === 'r0')).toMatchObject({ answer: 'allowed' });
      expect(byId((i) => i.type === 'approval' && i.requestId === 'r1')).toMatchObject({ answer: 'denied' });
    }
  });

  it('notes a stop only while Claude was working', () => {
    expect(applyEvents(emptyChat, [ev({ kind: 'stopped' })]).items).toHaveLength(0);
    const v = applyEvents(emptyChat, [ev({ kind: 'user', text: 'x' }), ev({ kind: 'stopped' })]);
    expect(v.items[1]).toMatchObject({ type: 'notice', text: 'Stopped.' });
    expect(v.busy).toBe(false);
  });
});
