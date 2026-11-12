// Mirrors src-tauri/src/model.rs
export type Engine = 'mysql' | 'sqlite';
export type Environment = 'local' | 'dev' | 'staging' | 'prod';
export type TlsMode = 'off' | 'required' | 'verify';
export type ClaudeAccess = 'data' | 'schema' | 'off';
/** SQL keywords a cell edit may set instead of data (the backend writes only these into SQL) */
export type SqlKeyword = 'DEFAULT' | 'CURRENT_TIMESTAMP' | 'CURRENT_DATE' | 'CURRENT_TIME';
export interface SqlExpr {
  $expr: SqlKeyword;
}
/** A cell value; `SqlExpr` only appears in unsaved edits */
export type Cell = string | number | boolean | null | SqlExpr;

export const isSqlExpr = (v: unknown): v is SqlExpr => typeof v === 'object' && v !== null && '$expr' in v;

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: Engine;
  environment: Environment;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  database?: string | null;
  tls?: TlsMode;
  filePath?: string | null;
  /** null/undefined = default for the environment */
  claudeAccess?: ClaudeAccess | null;
  /** folder Claude may read */
  projectFolder?: string | null;
  /** project the connection belongs to (groups connections in the list and the rail) */
  group?: string | null;
}

export interface ConnectionInput extends ConnectionConfig {
  /** undefined = keep stored password */
  password?: string;
}

export interface ServerInfo {
  version: string;
  currentDatabase: string | null;
}

export type ObjectKind = 'table' | 'view';

export interface DbObject {
  name: string;
  kind: ObjectKind;
  rowEstimate: number | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface TableStructure {
  name: string;
  kind: ObjectKind;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string | null;
}

export interface SortSpec {
  column: string;
  descending: boolean;
}

export interface PageRequest {
  database?: string | null;
  table: string;
  filter?: string | null;
  sort: SortSpec[];
  limit: number;
  offset: number;
}

export interface ResultColumn {
  name: string;
  typeName: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Cell[][];
  affectedRows: number | null;
  elapsedMs: number;
  truncated: boolean;
  statement: string | null;
}

export type RowValues = Record<string, Cell>;

export interface ChangeSet {
  updates: { key: RowValues; values: RowValues }[];
  inserts: RowValues[];
  deletes: RowValues[];
}

export interface StatementRange {
  start: number;
  end: number;
  text: string;
}

/** Mirrors backup::JobStatus */
export interface JobStatus {
  label: string;
  done: number;
  total: number;
  finished: boolean;
  error: string | null;
}

/** Mirrors model::SavedQuery */
export interface SavedQuery {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  database: string | null;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  database: string | null;
  sql: string;
  executedAt: string;
  elapsedMs: number;
  ok: boolean;
  /** "cli": an agent ran it with the `rowline` command */
  source?: 'cli';
  /** why it failed or was blocked (CLI) */
  error?: string;
  /** rows returned (CLI) */
  rows?: number;
}

/** Production defaults to schema only, every other environment to data (mirrors ConnectionConfig::claude_access). */
export function effectiveClaudeAccess(c: Pick<ConnectionConfig, 'claudeAccess' | 'environment'>): ClaudeAccess {
  return c.claudeAccess ?? (c.environment === 'prod' ? 'schema' : 'data');
}

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface ChatConnection {
  id: string;
  database: string | null;
}

/** Mirrors claude::events::NumberedEvent */
export type ChatEvent = { seq: number } & (
  | { kind: 'user'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'activity'; label: string }
  | { kind: 'tool_call'; callId: string; tool: string; connection: string | null; database: string | null; sql: string | null }
  | { kind: 'tool_result'; callId: string; rows: number | null; truncated: boolean; elapsedMs: number | null; error: string | null }
  | { kind: 'approval'; requestId: string; connection: string; connectionName: string; sql: string }
  | { kind: 'approval_answered'; requestId: string; allowed: boolean }
  | { kind: 'done'; durationMs: number | null; costUsd: number | null }
  | { kind: 'stopped' }
  | { kind: 'error'; errorKind: string; message: string }
);
