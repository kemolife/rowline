import type { ConnectionConfig, DbObject, Engine, QueryResult } from './types';

/** MySQL and PostgreSQL: a server with host, port, user, databases (SQLite is a file) */
export function isServer(e: Engine): boolean {
  return e === 'mysql' || e === 'postgres';
}

/** A table or column name as SQL text: backticks for MySQL, double quotes for PostgreSQL and SQLite */
export function quoteIdent(e: Engine, name: string): string {
  return e === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function engineLabel(e: Engine): 'MySQL' | 'SQLite' | 'PostgreSQL' {
  return e === 'mysql' ? 'MySQL' : e === 'postgres' ? 'PostgreSQL' : 'SQLite';
}

export function defaultPort(e: Engine): number | null {
  return e === 'mysql' ? 3306 : e === 'postgres' ? 5432 : null;
}

export function defaultUser(e: Engine): string | null {
  return e === 'mysql' ? 'root' : e === 'postgres' ? 'postgres' : null;
}

/** Language name for sql-formatter (and the CodeMirror dialect to pick) */
export function sqlDialectName(e: Engine): 'mysql' | 'postgresql' | 'sqlite' {
  return e === 'mysql' ? 'mysql' : e === 'postgres' ? 'postgresql' : 'sqlite';
}

/** Prod Postgres runs every UI query read-only until the tab unlocks writes */
export function prodLocked(c: Pick<ConnectionConfig, 'engine' | 'environment'>): boolean {
  return c.engine === 'postgres' && c.environment === 'prod';
}

/**
 * The schema a Postgres database opens with: `public` when it has tables, else the first schema with tables,
 * else the first schema, else null. Returns the objects of the picked schema, so they need no second load.
 */
export async function pickSchema(schemas: string[], objectsOf: (schema: string) => Promise<DbObject[]>): Promise<{ schema: string | null; objects: DbObject[] }> {
  const order = schemas.includes('public') ? ['public', ...schemas.filter((s) => s !== 'public')] : schemas;
  const seen: Record<string, DbObject[]> = {};
  for (const s of order) {
    seen[s] = await objectsOf(s);
    if (seen[s].some((o) => o.kind === 'table')) return { schema: s, objects: seen[s] };
  }
  const first = schemas[0] ?? null;
  return { schema: first, objects: first ? (seen[first] ?? []) : [] };
}

/** Tab and header name of a table: `invoices` in `public` (or without a schema), `billing.invoices` otherwise */
export function tableTitle(table: string, schema: string | null | undefined): string {
  return schema && schema !== 'public' ? `${schema}.${table}` : table;
}

/**
 * Schema and table of a name that may carry a schema: a `schema_columns` key (`billing.invoices`) or a foreign key
 * target in another schema (`public.Orders`). The prefix counts only when it is another known schema, so a table
 * whose own name has a dot stays whole.
 */
export function splitTableKey(key: string, ownSchema: string, schemas: string[]): { schema: string; table: string } {
  const dot = key.indexOf('.');
  if (dot > 0) {
    const prefix = key.slice(0, dot);
    if (prefix !== ownSchema && schemas.includes(prefix)) return { schema: prefix, table: key.slice(dot + 1) };
  }
  return { schema: ownSchema, table: key };
}

/**
 * Key of data kept per database, and per schema on Postgres (diagram cache, snapshots, virtual keys, pins):
 * `shop/billing`. Without a schema (MySQL, SQLite) it is the database itself, so their saved data keeps its key.
 */
export function scopeKey(database: string | null, schema: string | null | undefined): string | null {
  return schema ? `${database ?? ''}/${schema}` : database;
}

/** Text of the "Unlock writes" confirmation on a prod Postgres tab */
export function unlockQuestion(connection: string, database: string | null): string {
  return `Allow changes to ${connection} / ${database ?? 'the database'} in this tab? Other tabs, Claude and udb stay read-only.`;
}

/** Postgres runs a script in one transaction: when a statement fails, the ones before it are rolled back too */
export function rollbackNote(engine: Engine, results: QueryResult[]): string | null {
  if (engine !== 'postgres') return null;
  const failed = results.findIndex((r) => r.error);
  return failed > 0 ? 'PostgreSQL runs the script in one transaction: the earlier statements of this run were rolled back.' : null;
}
