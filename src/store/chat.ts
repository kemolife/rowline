import { create } from 'zustand';
import { api } from '../lib/api';
import { applyEvents, emptyChat, type ChatView } from '../lib/chat';
import type { ChatConnection, ClaudeStatus } from '../lib/types';
import { useApp } from './app';

export interface ChatSlot {
  chatId: string | null;
  view: ChatView;
  /** other open connections added with the chip */
  extra: string[];
}

interface ChatState {
  chats: Record<string, ChatSlot>;
  status: ClaudeStatus | null;
  noticeSeen: boolean;
  checkStatus: () => Promise<void>;
  send: (cid: string, text: string) => Promise<void>;
  stop: (cid: string) => Promise<void>;
  newChat: (cid: string) => Promise<void>;
  answer: (cid: string, requestId: string, allow: boolean) => Promise<void>;
  setExtra: (cid: string, ids: string[]) => void;
  dismissNotice: () => void;
  /** text waiting to be put into the Claude panel's input (from "Ask Claude" buttons elsewhere) */
  drafts: Record<string, string>;
  /** Opens the Claude panel with this text in its input, ready to edit and send. */
  compose: (cid: string, text: string) => void;
  takeDraft: (cid: string) => string | null;
}

const NOTICE_KEY = 'rowline.claude.noticeSeen';
const readNotice = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
};

const blank = (): ChatSlot => ({ chatId: null, view: emptyChat, extra: [] });
const generations = new Map<string, number>();
const generation = (cid: string) => generations.get(cid) ?? 0;
const bump = (cid: string) => generations.set(cid, generation(cid) + 1);
const starting = new Map<string, Promise<string | null>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** set while the startup cleanup runs */
let leftoversClosed: Promise<unknown> | null = null;

/** Once at startup: closes chats (and their Claude Code processes) left by an earlier page load. New chats wait for it. */
export function closeLeftoverChats(): Promise<unknown> {
  const p = api.chatCloseAll().catch(() => undefined).finally(() => {
    if (leftoversClosed === p) leftoversClosed = null;
  });
  leftoversClosed = p;
  return p;
}

/** The chat's own connection first, then the extra ones that are still open. */
function connectionsFor(cid: string, extra: string[]): ChatConnection[] {
  const ws = useApp.getState().workspaces;
  return [cid, ...extra.filter((id) => id !== cid && ws[id])].map((id) => ({ id, database: ws[id]?.session.database ?? null }));
}

export const useChat = create<ChatState>((set, get) => {
  const slot = (cid: string) => get().chats[cid] ?? blank();
  const patch = (cid: string, p: Partial<ChatSlot>) => set({ chats: { ...get().chats, [cid]: { ...slot(cid), ...p } } });

  /** Long-polls the backend until the chat is closed or replaced. */
  const poll = async (cid: string, chatId: string) => {
    let retryMs = 1000;
    for (;;) {
      const cur = get().chats[cid];
      if (!cur || cur.chatId !== chatId) return;
      try {
        const events = await api.chatEvents(chatId, cur.view.lastSeq);
        const now = get().chats[cid];
        if (!now || now.chatId !== chatId) return;
        if (events.length) patch(cid, { view: applyEvents(now.view, events) });
      } catch (e) {
        if (String((e as Error).message).includes('Unknown chat')) {
          if (get().chats[cid]?.chatId === chatId) patch(cid, { chatId: null });
          return;
        }
        // backend not reachable: retry, waiting longer each time (1 s up to 10 s)
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    }
  };

  /** Resolves null when the connection was closed or the chat reset while it was starting. */
  const ensureChat = (cid: string): Promise<string | null> => {
    const s = slot(cid);
    if (s.chatId) return Promise.resolve(s.chatId);
    const pending = starting.get(cid);
    if (pending) return pending;
    const gen = generation(cid);
    const p = (async () => {
      if (leftoversClosed) await leftoversClosed;
      const { chatId } = await api.chatStart(connectionsFor(cid, s.extra));
      if (!useApp.getState().workspaces[cid] || generation(cid) !== gen) {
        await api.chatClose(chatId).catch(() => undefined);
        return null;
      }
      patch(cid, { chatId, view: { ...emptyChat } });
      void poll(cid, chatId);
      return chatId;
    })().finally(() => {
      if (starting.get(cid) === p) starting.delete(cid);
    });
    starting.set(cid, p);
    return p;
  };

  return {
    drafts: {},
    compose: (cid, text) => {
      set({ drafts: { ...get().drafts, [cid]: text } });
      if (!useApp.getState().claudeOpen) useApp.getState().toggleClaude();
    },
    takeDraft: (cid) => {
      const d = get().drafts[cid];
      if (d == null) return null;
      const { [cid]: _taken, ...rest } = get().drafts;
      set({ drafts: rest });
      return d;
    },

    chats: {},
    status: null,
    noticeSeen: readNotice(),

    checkStatus: async () => {
      try {
        set({ status: await api.claudeStatus() });
      } catch {
        set({ status: { found: false, path: null, version: null } });
      }
    },

    send: async (cid, text) => {
      try {
        const chatId = await ensureChat(cid);
        if (!chatId) return;
        await api.chatSetConnections(chatId, connectionsFor(cid, slot(cid).extra));
        await api.chatSend(chatId, text);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },

    stop: async (cid) => {
      const chatId = slot(cid).chatId;
      if (chatId) await api.chatStop(chatId).catch(() => undefined);
    },

    newChat: async (cid) => {
      bump(cid);
      const chatId = slot(cid).chatId;
      patch(cid, { chatId: null, view: emptyChat });
      if (chatId) await api.chatClose(chatId).catch(() => undefined);
    },

    answer: async (_cid, requestId, allow) => {
      try {
        await api.answerApproval(requestId, allow);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },

    setExtra: (cid, extra) => {
      patch(cid, { extra });
      const chatId = slot(cid).chatId;
      if (chatId) api.chatSetConnections(chatId, connectionsFor(cid, extra)).catch(() => undefined);
    },

    dismissNotice: () => {
      try {
        localStorage.setItem(NOTICE_KEY, '1');
      } catch {
        /* storage not available */
      }
      set({ noticeSeen: true });
    },
  };
});

// A closed connection closes its chat (the backend kills its Claude Code process).
useApp.subscribe((state, prev) => {
  if (state.workspaces === prev.workspaces) return;
  for (const cid of Object.keys(prev.workspaces)) {
    if (state.workspaces[cid]) continue;
    bump(cid);
    const s = useChat.getState().chats[cid];
    if (!s) continue;
    const { [cid]: _closed, ...rest } = useChat.getState().chats;
    useChat.setState({ chats: rest });
    if (s.chatId) api.chatClose(s.chatId).catch(() => undefined);
  }
});
