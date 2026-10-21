import type { SchemaSnapshot, SchemaTable } from './schemaDiff';
import type { VirtualKey } from './virtualKeys';
import type {
  ChangeSet,
  ChatConnection,
  ChatEvent,
  ClaudeStatus,
  ConnectionConfig,
  ConnectionInput,
  DbObject,
  HistoryEntry,
  JobStatus,
  SavedQuery,
  PageRequest,
  QueryResult,
  ServerInfo,
  StatementRange,
  TableStructure,
} from './types';

/** Inside the Tauri app */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const DEV_BRIDGE_URL = import.meta.env.VITE_DEV_BRIDGE_URL ?? 'http://127.0.0.1:1421';

export class ApiError extends Error {}

/** Calls a backend command: Tauri `invoke` in the app, the HTTP dev bridge in a browser. */
async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<T>('call', { command, args });
    } catch (e) {
      throw new ApiError((e as { message?: string })?.message ?? String(e));
    }
  }
  const res = await fetch(`${DEV_BRIDGE_URL}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  const body = await res.json();
  if (!res.ok) throw new ApiError(body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>('list_connections'),
  saveConnection: (input: ConnectionInput) => call<ConnectionConfig>('save_connection', { ...input }),
  deleteConnection: (id: string) => call<boolean>('delete_connection', { id }),
  testConnection: (input: ConnectionInput) => call<ServerInfo>('test_connection', { ...input }),
  connect: (id: string) => call<ServerInfo>('connect', { id }),
  disconnect: (id: string) => call<boolean>('disconnect', { id }),
  /** the database the app shows; the `rowline` command uses it by default */
  setActiveDatabase: (id: string, database: string | null) => call<boolean>('set_active_database', { id, database }),
  cliStatus: () => call<{ installed: boolean; link: string | null; target: string | null; socket: string }>('cli_status'),
  installCli: () => call<string>('install_cli'),
  listDatabases: (id: string) => call<string[]>('list_databases', { id }),
  listObjects: (id: string, database: string | null) => call<DbObject[]>('list_objects', { id, database }),
  schemaColumns: (id: string, database: string | null) => call<Record<string, string[]>>('schema_columns', { id, database }),
  tableStructure: (id: string, database: string | null, table: string) =>
    call<TableStructure>('table_structure', { id, database, table }),
  selectPage: (id: string, request: PageRequest) => call<QueryResult>('select_page', { id, request }),
  countRows: (id: string, request: PageRequest) => call<number>('count_rows', { id, request }),
  executeSql: (id: string, database: string | null, sql: string, maxRows?: number) =>
    call<QueryResult[]>('execute_sql', { id, database, sql, maxRows }),
  previewChanges: (id: string, database: string | null, table: string, changes: ChangeSet) =>
    call<string[]>('preview_changes', { id, database, table, changes }),
  applyChanges: (id: string, database: string | null, table: string, changes: ChangeSet) =>
    call<number>('apply_changes', { id, database, table, changes }),
  cancelQuery: (id: string) => call<boolean>('cancel_query', { id }),
  /** most common values of a column (filter suggestions); empty when the server is slow */
  commonValues: (id: string, database: string | null, table: string, column: string) => call<(string | number | null)[]>('common_values', { id, database, table, column }),
  listVirtualKeys: (connectionId: string, database: string | null) => call<VirtualKey[]>('list_virtual_keys', { connectionId, database }),
  saveVirtualKey: (key: Omit<VirtualKey, 'id'> & { id?: string }) => call<VirtualKey>('save_virtual_key', { id: '', ...key }),
  deleteVirtualKey: (id: string) => call<null>('delete_virtual_key', { id }),
  schemaGraph: (id: string, database: string | null) => call<SchemaTable[]>('schema_graph', { id, database }),
  schemaSnapshots: (id: string, database: string | null) => call<SchemaSnapshot[]>('schema_snapshots', { id, database }),
  saveSchemaSnapshot: (id: string, database: string | null) => call<SchemaSnapshot>('schema_snapshot_save', { id, database }),
  splitStatements: (sql: string) => call<StatementRange[]>('split_statements', { sql }),
  isReadOnly: (sql: string) => call<boolean>('is_read_only', { sql }),
  listHistory: (connectionId?: string) => call<HistoryEntry[]>('list_history', { connectionId }),
  listSavedQueries: (connectionId: string) => call<SavedQuery[]>('list_saved_queries', { connectionId }),
  saveQuery: (q: { id?: string; connectionId: string; name: string; sql: string; database: string | null }) => call<SavedQuery>('save_query', { ...q }),
  deleteSavedQuery: (id: string) => call<boolean>('delete_saved_query', { id }),
  writeTextFile: (path: string, content: string) => call<boolean>('write_text_file', { path, content }),
  readTextFile: (path: string) => call<string>('read_text_file', { path }),
  backupStart: (id: string, database: string | null, path: string) => call<{ jobId: string }>('backup_start', { id, database, path }),
  restoreStart: (id: string, database: string | null, path: string) => call<{ jobId: string }>('restore_start', { id, database, path }),
  jobStatus: (jobId: string) => call<JobStatus>('job_status', { jobId }),
  jobCancel: (jobId: string) => call<boolean>('job_cancel', { jobId }),
  claudeStatus: () => call<ClaudeStatus>('claude_status'),
  chatStart: (connections: ChatConnection[]) => call<{ chatId: string }>('chat_start', { connections }),
  chatSetConnections: (chatId: string, connections: ChatConnection[]) => call<boolean>('chat_set_connections', { chatId, connections }),
  chatSend: (chatId: string, text: string) => call<boolean>('chat_send', { chatId, text }),
  chatEvents: (chatId: string, after: number) => call<ChatEvent[]>('chat_events', { chatId, after }),
  chatStop: (chatId: string) => call<boolean>('chat_stop', { chatId }),
  chatClose: (chatId: string) => call<boolean>('chat_close', { chatId }),
  /** closes chats left by an earlier page load (reload) */
  chatCloseAll: () => call<boolean>('chat_close_all'),
  answerApproval: (requestId: string, allow: boolean) => call<boolean>('answer_approval', { requestId, allow }),
};

/** Appends a frontend error to client-errors.log in the app config folder (never throws). */
export function logClientError(message: string) {
  call('log_client_error', { message: message.slice(0, 20_000) }).catch(() => undefined);
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => logClientError(`window.onerror: ${e.message}\n${e.error?.stack ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => logClientError(`unhandledrejection: ${String(e.reason?.stack ?? e.reason)}`));
}

/** Native open/save dialogs in the app; prompt() fallback in the browser dev setup. */
export async function pickSqliteFile(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({
      multiple: false,
      filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 's3db'] }, { name: 'All files', extensions: ['*'] }],
    });
    return typeof res === 'string' ? res : null;
  }
  return window.prompt('SQLite file path');
}

/** Text of a file the user picks (for a cell value); null when cancelled. */
export async function pickTextFileContent(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ multiple: false });
    return typeof res === 'string' ? api.readTextFile(res) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 10 * 1024 * 1024) return resolve(Promise.reject(new Error('The file is too big for a cell (the limit is 10 MB).')));
      file.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

export async function pickFolder(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ directory: true, multiple: false });
    return typeof res === 'string' ? res : null;
  }
  return window.prompt('Project folder path');
}

export async function pickSavePath(defaultName: string, extension: string, promptInBrowser = false): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({ defaultPath: defaultName, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  }
  // dev bridge in a browser: no native dialog
  return promptInBrowser ? window.prompt('Save to (full path)', `/tmp/${defaultName}`) : null;
}

/** A file to open; `extensions` limits the choice (an "All files" entry is always added). */
export async function pickOpenPath(label: string, extensions: string[]): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ multiple: false, filters: [{ name: label, extensions }, { name: 'All files', extensions: ['*'] }] });
    return typeof res === 'string' ? res : null;
  }
  return window.prompt('File to open (full path)');
}

/** Yes/no question: native dialog in the app (WKWebView has no window.confirm UI), window.confirm in a browser. */
export async function confirmDialog(message: string, options: { title?: string; danger?: boolean } = {}): Promise<boolean> {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title: options.title ?? 'Rowline', kind: options.danger ? 'warning' : 'info' });
  }
  return window.confirm(message);
}
