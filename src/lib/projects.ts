/** Projects (connection groups): a name on the connection, a color made from the name */

/** Colors that read well on light and dark backgrounds; environment colors stay separate */
const COLORS = ['#7c5cd6', '#2f9e8f', '#d0742c', '#c2477f', '#4f7fd8', '#8a9a2a', '#b65bc4', '#3d9bc2'];

export function projectColor(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** `2Solar` → `2S`, `legacy local docker` → `LL` */
export function projectBadge(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Connections grouped by project: named projects A–Z first, connections without a project last */
export function groupByProject<T extends { group?: string | null }>(items: T[]): { group: string | null; items: T[] }[] {
  const map = new Map<string, T[]>();
  const none: T[] = [];
  for (const it of items) {
    const g = it.group?.trim();
    if (!g) none.push(it);
    else (map.get(g) ?? map.set(g, []).get(g)!).push(it);
  }
  const named = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, list]) => ({ group, items: list }));
  return none.length ? [...named, { group: null, items: none }] : named;
}

/**
 * Where a newly opened connection goes in the rail: right after the open connections of its project,
 * so a project's connections stay together (⌘1…⌘9 follow this order).
 */
export function insertGrouped(order: string[], id: string, groupOf: (id: string) => string | null | undefined): string[] {
  const rest = order.filter((o) => o !== id);
  const g = groupOf(id)?.trim() || null;
  if (!g) return [...rest, id];
  let last = -1;
  rest.forEach((o, i) => {
    if ((groupOf(o)?.trim() || null) === g) last = i;
  });
  if (last < 0) return [...rest, id];
  return [...rest.slice(0, last + 1), id, ...rest.slice(last + 1)];
}

/** A connection's project: set by the user, or guessed (`auto`) */
export interface ProjectInfo {
  name: string;
  auto: boolean;
}

/** words that name an environment, not a project */
const ENV_WORDS = new Set(['dev', 'develop', 'development', 'staging', 'stage', 'stg', 'prod', 'production', 'prd', 'live', 'local', 'localhost', 'test', 'testing', 'qa', 'uat', 'acc', 'acceptance', 'demo', 'copy', 'backup', 'old', 'new', 'db', 'mysql', 'sqlite']);

/** `2Solar-staging DB` → `2Solar`; null when the name has nothing but environment words */
export function namePrefix(name: string): string | null {
  const words = name.split(/[\s\-_./()[\]]+/).filter(Boolean);
  return words.find((w) => !ENV_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w)) ?? null;
}

interface Guessable {
  id: string;
  name: string;
  group?: string | null;
  database?: string | null;
  filePath?: string | null;
}

/** The database a connection opens: the default database, or the SQLite file name */
function databaseOf(c: Guessable): string | null {
  if (c.database?.trim()) return c.database.trim();
  const file = c.filePath?.split('/').pop()?.replace(/\.(sqlite3?|db3?|s3db)$/i, '');
  return file?.trim() || null;
}

/**
 * Projects of all connections. A project typed by the user always wins. Without one, a connection is
 * grouped (1) with others whose names start with the same word (`2solar dev`, `2Solar-prod`), or with a
 * project of that name, else (2) with others that open the same database. A guess needs at least two
 * connections; a lonely connection has no project.
 */
export function effectiveProjects(connections: Guessable[]): Map<string, ProjectInfo> {
  const out = new Map<string, ProjectInfo>();
  const explicit = new Map<string, string>(); // lower case → name as typed
  for (const c of connections) {
    const g = c.group?.trim();
    if (g) {
      out.set(c.id, { name: g, auto: false });
      if (!explicit.has(g.toLowerCase())) explicit.set(g.toLowerCase(), g);
    }
  }
  const open = connections.filter((c) => !out.has(c.id));

  // (1) first word of the name
  const byPrefix = new Map<string, Guessable[]>();
  for (const c of open) {
    const p = namePrefix(c.name)?.toLowerCase();
    if (p) (byPrefix.get(p) ?? byPrefix.set(p, []).get(p)!).push(c);
  }
  for (const [p, list] of byPrefix) {
    const joinsExplicit = explicit.has(p);
    if (list.length < 2 && !joinsExplicit) continue;
    const name = explicit.get(p) ?? namePrefix(list[0].name)!;
    for (const c of list) out.set(c.id, { name, auto: true });
  }

  // (2) same database
  const byDb = new Map<string, Guessable[]>();
  for (const c of open) {
    if (out.has(c.id)) continue;
    const db = databaseOf(c)?.toLowerCase();
    if (db) (byDb.get(db) ?? byDb.set(db, []).get(db)!).push(c);
  }
  for (const [db, list] of byDb) {
    if (list.length < 2 && !explicit.has(db)) continue;
    const name = explicit.get(db) ?? databaseOf(list[0])!;
    for (const c of list) out.set(c.id, { name, auto: true });
  }
  return out;
}

/** "5 min ago", "2 h ago", "Yesterday", "3 days ago", "12 Oct" */
export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'Never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Production first, then staging, dev, local: the dangerous ones stand out at the top */
export const ENV_ORDER: Record<string, number> = { prod: 0, staging: 1, dev: 2, local: 3 };
