import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  isTauri: false,
  api: {
    chatStart: vi.fn(),
    chatSetConnections: vi.fn(async () => true),
    chatSend: vi.fn(async () => true),
    chatEvents: vi.fn(() => new Promise(() => undefined)),
    chatClose: vi.fn(async () => true),
    chatStop: vi.fn(async () => true),
    chatCloseAll: vi.fn(async () => true),
  },
  confirmDialog: vi.fn(async () => true),
}));

import { api } from '../lib/api';
import { useApp } from './app';
import { closeLeftoverChats, useChat } from './chat';

const ws = (cid: string) => ({ [cid]: { session: { database: 'shop' }, tabs: [], activeTabId: null } }) as never;

function deferredStart() {
  let resolve!: (v: { chatId: string }) => void;
  vi.mocked(api.chatStart).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (id: string) => resolve({ chatId: id });
}

describe('chat store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ workspaces: ws('a') });
    useChat.setState({ chats: {} });
  });

  it('shares one chatStart between concurrent sends', async () => {
    const finish = deferredStart();
    const p1 = useChat.getState().send('a', 'one');
    const p2 = useChat.getState().send('a', 'two');
    finish('c1');
    await Promise.all([p1, p2]);
    expect(api.chatStart).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.chatSend).mock.calls).toEqual([['c1', 'one'], ['c1', 'two']]);
  });

  it('closes a chat started before New chat', async () => {
    const finish = deferredStart();
    const p = useChat.getState().send('a', 'x');
    await useChat.getState().newChat('a');
    finish('c2');
    await p;
    expect(api.chatClose).toHaveBeenCalledWith('c2');
    expect(api.chatSend).not.toHaveBeenCalled();
    expect(useChat.getState().chats.a?.chatId ?? null).toBeNull();
  });

  it('closes a chat started for a connection that was closed', async () => {
    const finish = deferredStart();
    const p = useChat.getState().send('a', 'x');
    useApp.setState({ workspaces: {} });
    finish('c3');
    await p;
    expect(api.chatClose).toHaveBeenCalledWith('c3');
    expect(useChat.getState().chats.a).toBeUndefined();
  });

  it('a chat started during the startup cleanup waits for it', async () => {
    let finishCleanup!: () => void;
    vi.mocked(api.chatCloseAll).mockImplementationOnce(() => new Promise((r) => (finishCleanup = () => r(true))));
    vi.mocked(api.chatStart).mockImplementationOnce(async () => ({ chatId: 'c4' }));
    const cleanup = closeLeftoverChats();
    const p = useChat.getState().send('a', 'x');
    await Promise.resolve();
    expect(api.chatStart).not.toHaveBeenCalled();
    finishCleanup();
    await cleanup;
    await p;
    expect(api.chatStart).toHaveBeenCalledTimes(1);
    expect(api.chatSend).toHaveBeenCalledWith('c4', 'x');
  });
});
