import type { ConnectionConfig, DbObject, Engine } from './types';

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
