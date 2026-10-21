import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { changeLines, type TableView } from './schemaDiff';
import type { Engine } from './types';

/** Size of a table box on the diagram */
export const HEAD_H = 34;
export const ROW_H = 22;
export const NODE_W_MIN = 180;
export const NODE_W_MAX = 340;

/** most column rows a box shows; old tables can have 100+ columns */
export const MAX_BOX_COLUMNS = 12;

/**
 * Columns a box shows: keys only (primary key, foreign keys, columns of guessed relations, changed columns),
 * at most MAX_BOX_COLUMNS. All columns are listed in the side panel.
 */
export function visibleColumns(t: TableView, related: ReadonlySet<string> = new Set()) {
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  return t.columns.filter((c) => c.primaryKey || fkCols.has(c.name) || related.has(c.name) || c.change).slice(0, MAX_BOX_COLUMNS);
}

export function nodeSize(t: TableView, related?: ReadonlySet<string>): { width: number; height: number } {
  const cols = visibleColumns(t, related);
  const hidden = t.columns.length - cols.length;
  const longest = Math.max(t.name.length + 8, ...cols.map((c) => c.name.length + Math.min(c.dataType.length, 18) + 6));
  return {
    width: Math.min(NODE_W_MAX, Math.max(NODE_W_MIN, Math.round(longest * 7.2 + 24))),
    height: HEAD_H + cols.length * ROW_H + (hidden ? ROW_H : 0) + 2,
  };
}

/** A relation between two tables: a foreign key, or one guessed from a column name */
export interface Relation {
  id: string;
  from: string;
  fromColumns: string[];
  to: string;
  toColumns: string[];
  change: 'added' | 'removed' | null;
  /** one-to-one when the foreign key columns are unique (primary key or unique index) */
  kind: 'one-to-one' | 'many-to-one';
  /** a foreign key column can be NULL: the row may have no related row */
  optional: boolean;
  /** no foreign key in the database; matched by name (`ds_person_id` → `ds_person.ds_person_id`) */
  guessed: boolean;
  /** a virtual foreign key the user saved in Rowline */
  virtual?: boolean;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const NUMERIC = /int|decimal|numeric|serial|bit/i;

function relationShape(t: TableView, columns: string[]): Pick<Relation, 'kind' | 'optional'> {
  const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const unique = [pk, ...t.uniqueKeys].some((k) => k.length && sameSet(k, columns));
  const optional = columns.some((n) => t.columns.find((c) => c.name === n)?.nullable ?? true);
  return { kind: unique ? 'one-to-one' : 'many-to-one', optional };
}

/**
 * Foreign keys between known tables; with `guess`, also `<name>_id` columns that match a table
 * (`customer_id` → `customer(s)`) or another table's own primary key column (`ds_person_id` → `ds_person`).
 */
export function relationsOf(tables: TableView[], guess = false): Relation[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const out: Relation[] = [];
  for (const t of tables) {
    for (const f of t.foreignKeys) {
      const target = byName.get(f.refTable.toLowerCase());
      if (!target) continue;
      out.push({
        id: `${t.name}:${f.name}:${f.columns.join(',')}`,
        from: t.name,
        fromColumns: f.columns,
        to: target.name,
        toColumns: f.refColumns,
        change: f.change,
        guessed: false,
        virtual: f.name.startsWith('virtual:'),
        ...relationShape(t, f.columns),
      });
    }
  }
  if (!guess) return out;

  // single-column primary keys, by column name (only names used by one table)
  const pkOwner = new Map<string, TableView | null>();
  for (const t of tables) {
    const pk = t.columns.filter((c) => c.primaryKey && c.change !== 'removed');
    if (pk.length !== 1) continue;
    const key = pk[0].name.toLowerCase();
    pkOwner.set(key, pkOwner.has(key) ? null : t);
  }
  const singlePk = (t: TableView) => {
    const pk = t.columns.filter((c) => c.primaryKey && c.change !== 'removed');
    return pk.length === 1 ? pk[0] : null;
  };
  for (const t of tables) {
    const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
    for (const c of t.columns) {
      const m = /^(.+)_id$/i.exec(c.name);
      if (!m || fkCols.has(c.name) || c.change === 'removed') continue;
      const base = m[1].toLowerCase();
      let target: TableView | null | undefined = pkOwner.get(c.name.toLowerCase());
      if (target === t) target = null; // its own primary key
      if (!target) {
        for (const name of [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')]) {
          const cand = byName.get(name);
          if (cand && cand !== t) {
            target = cand;
            break;
          }
        }
      }
      const pk = target ? singlePk(target) : null;
      if (!target || !pk) continue;
      // numbers point to numbers, text to text
      if (NUMERIC.test(c.dataType) !== NUMERIC.test(pk.dataType)) continue;
      out.push({ id: `${t.name}:guess:${c.name}`, from: t.name, fromColumns: [c.name], to: target.name, toColumns: [pk.name], change: null, guessed: true, ...relationShape(t, [c.name]) });
    }
  }
  return out;
}

/** "N:1", "1:1" */
export const kindLabel = (r: Relation) => (r.kind === 'one-to-one' ? '1:1' : 'N:1');

let elk: { layout: InstanceType<typeof ELK>['layout'] } | null = null;

/** ELK runs in a worker so a big diagram does not freeze the window; tests (no Worker) use the bundled copy */
async function getElk() {
  if (elk) return elk;
  if (typeof Worker !== 'undefined') elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
  else {
    const { default: Bundled } = await import('elkjs/lib/elk.bundled.js');
    elk = new Bundled();
  }
  return elk;
}

/** Positions for every table: related tables flow left to right, unrelated ones are packed below. */
export async function layout(boxes: { id: string; width: number; height: number }[], relations: Relation[]): Promise<Record<string, { x: number; y: number }>> {
  const elk = await getElk();
  const ids = new Set(boxes.map((b) => b.id));
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '36',
      'elk.spacing.componentComponent': '60',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      // the diagram draws its own lines; cheap routing halves the layout time on big schemas
      'elk.edgeRouting': 'POLYLINE',
      'elk.layered.thoroughness': '3',
    },
    children: boxes.map((b) => ({ id: b.id, width: b.width, height: b.height })),
    edges: relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to).map((r) => ({ id: r.id, sources: [r.from], targets: [r.to] })),
  });
  return wrapTallLayers((graph.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 })));
}

const MAX_LAYER_H = 1600;
const WRAP_GAP_X = 40;
const WRAP_GAP_Y = 36;

/**
 * The layered layout puts every table that points to the same table in one column: a hub with 60 tables
 * becomes a 6,000 px tall line. Columns taller than MAX_LAYER_H are wrapped into several side by side.
 */
export function wrapTallLayers(boxes: { id: string; x: number; y: number; width: number; height: number }[]): Record<string, { x: number; y: number }> {
  const sorted = [...boxes].sort((a, b) => a.x - b.x);
  const layers: (typeof boxes)[] = [];
  for (const b of sorted) {
    const last = layers[layers.length - 1];
    if (last && b.x - last[0].x < 40) last.push(b);
    else layers.push([b]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  const globalTop = Math.min(...boxes.map((b) => b.y));
  const kept: (typeof boxes)[] = [];
  let packedBottom: number | null = null;
  let shift = 0;
  for (const layer of layers) {
    const byY = [...layer].sort((a, b) => a.y - b.y);
    const last = byY[byY.length - 1];
    // fine as it is; otherwise packed (and wrapped) from the top, also when a few boxes were spread far apart
    if (last.y + last.height - byY[0].y <= MAX_LAYER_H) {
      for (const b of byY) out[b.id] = { x: b.x + shift, y: b.y };
      kept.push(byY);
      continue;
    }
    const top = globalTop;
    const left = Math.min(...byY.map((b) => b.x)) + shift;
    const colW = Math.max(...byY.map((b) => b.width)) + WRAP_GAP_X;
    let col = 0;
    let y = top;
    for (const b of byY) {
      if (y > top && y + b.height - top > MAX_LAYER_H) {
        col++;
        y = top;
      }
      out[b.id] = { x: left + col * colW, y };
      packedBottom = Math.max(packedBottom ?? 0, y + b.height);
      y += b.height + WRAP_GAP_Y;
    }
    shift += col * colW;
  }
  // columns left as they were but now below the packed area (e.g. the hub itself) move up to its middle
  if (packedBottom !== null) {
    const bottom = packedBottom;
    for (const layer of kept) {
      const top = layer[0].y;
      const extent = layer[layer.length - 1].y + layer[layer.length - 1].height - top;
      if (top + extent <= bottom) continue;
      const target = globalTop + Math.max(0, (bottom - globalTop - extent) / 2);
      for (const b of layer) out[b.id] = { x: out[b.id].x, y: b.y - top + target };
    }
  }
  return out;
}

const describeColumn = (c: TableView['columns'][number], fk: string | undefined) =>
  `${c.name} ${c.dataType}${c.primaryKey ? ' PK' : ''}${fk ? ` FK→${fk}` : ''}${c.nullable ? '' : ' NOT NULL'}${c.change === 'removed' ? ' (removed)' : ''}`;

/**
 * The message for Claude when asking about a selection on the diagram: the question first,
 * then the selected tables, their relations and their schema changes as context.
 */
export function diagramPrompt(opts: {
  question: string;
  database: string | null;
  engine: Engine;
  tables: TableView[];
  relations: Relation[];
  changesSince: string | null;
  projectFolder: string | null;
}): string {
  const { question, database, engine, tables, relations, changesSince, projectFolder } = opts;
  const lines: string[] = [question.trim(), '', `Context from the relation diagram of ${database ? `\`${database}\`` : 'the database'} (${engine === 'mysql' ? 'MySQL' : 'SQLite'}):`, '', 'Tables:'];
  for (const t of tables) {
    const fkOf = new Map<string, string>();
    for (const f of t.foreignKeys) f.columns.forEach((c, i) => fkOf.set(c, `${f.refTable}.${f.refColumns[i] ?? '?'}`));
    // MySQL's estimate is often 0 for tables whose statistics are out of date
    const rows = t.rowEstimate ? ` (~${t.rowEstimate} rows)` : '';
    const comment = t.comment ? ` — ${t.comment}` : '';
    lines.push(`- ${t.name}${t.kind === 'view' ? ' (view)' : ''}${rows}${comment}: ${t.columns.map((c) => describeColumn(c, fkOf.get(c.name))).join(', ')}`);
  }
  if (relations.length) {
    lines.push('', 'Relations:');
    for (const r of relations)
      lines.push(
        `- ${r.from}(${r.fromColumns.join(', ')}) → ${r.to}(${r.toColumns.join(', ')}) ${r.kind}${r.optional ? ', optional' : ''}${r.guessed ? ' (guessed from the column name, no foreign key)' : r.virtual ? ' (virtual foreign key confirmed by the user, not in the database)' : ''}${r.change ? ` (${r.change})` : ''}`,
      );
  }
  const changes = changeLines(tables);
  if (changes.length) {
    lines.push('', `Schema changes${changesSince ? ` since ${changesSince}` : ''} (compared with the saved snapshot):`, ...changes);
  }
  if (projectFolder) lines.push('', 'The project code is in the project folder you can read; look at its models, entities or migrations for these tables if that helps.');
  return lines.join('\n') + '\n';
}

/** Ready-made questions for a selection */
export function presetQuestions(tableCount: number, hasChanges: boolean): { label: string; question: string }[] {
  const many = tableCount > 1;
  return [
    { label: many ? 'Explain these tables' : 'Explain this table', question: many ? 'Explain what these tables store and what they are used for.' : 'Explain what this table stores and what it is used for.' },
    ...(many ? [{ label: 'How are they connected?', question: 'How are these tables connected? Explain the relations and what they mean.' }] : [{ label: 'What refers to it?', question: 'Which tables refer to this table, and how is it used with them?' }]),
    ...(hasChanges ? [{ label: 'What changed here?', question: 'Explain what changed in these tables since the snapshot, and why it may have changed.' }] : []),
    { label: many ? 'Write a JOIN query' : 'Write a query', question: many ? 'Write a useful SELECT that joins these tables. Show it as a query I can run.' : 'Write a useful SELECT for this table. Show it as a query I can run.' },
  ];
}

/** Tables linked to each table (both directions) */
export function neighbourMap(relations: Relation[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
  for (const r of relations) {
    if (r.from === r.to) continue;
    add(r.from, r.to);
    add(r.to, r.from);
  }
  return m;
}

/** Focus mode: the chosen tables and their direct neighbours */
export function focusedTables(roots: string[], neighbours: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const r of roots) {
    out.add(r);
    for (const n of neighbours.get(r) ?? []) out.add(n);
  }
  return out;
}

/** The most linked tables, a good place to start in a big database */
export function hubTables(neighbours: Map<string, Set<string>>, count = 12): { name: string; links: number }[] {
  return [...neighbours.entries()]
    .map(([name, s]) => ({ name, links: s.size }))
    .sort((a, b) => b.links - a.links || a.name.localeCompare(b.name))
    .slice(0, count);
}

/** A group of tables in the diagram outline: a well-linked table with the small tables around it */
export interface DiagramGroup {
  /** the table the group is named after */
  hub: string | null;
  tables: string[];
}

/**
 * Groups for the outline. Tables with 3+ links start a group (most linked first) and take their
 * neighbours with fewer than 3 links. Linked groups of one join together; a group still of one joins
 * the neighbour group it has the most links to.
 * Tables without links end in a last group with `hub: null`.
 */
export function groupTables(names: string[], neighbours: Map<string, Set<string>>): DiagramGroup[] {
  const shown = new Set(names);
  const near = (n: string) => [...(neighbours.get(n) ?? [])].filter((x) => shown.has(x) && x !== n);
  const degree = new Map(names.map((n) => [n, near(n).length]));
  const order = [...names].sort((a, b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b));
  const groupOf = new Map<string, string>();
  for (const t of order) {
    if (groupOf.has(t) || degree.get(t)! < 3) continue;
    groupOf.set(t, t);
    for (const n of near(t)) if (!groupOf.has(n) && degree.get(n)! < 3) groupOf.set(n, t);
  }
  // small tables not next to a group: with their best-linked neighbour
  for (const t of order) {
    if (groupOf.has(t) || !degree.get(t)) continue;
    const best = near(t).sort((a, b) => degree.get(b)! - degree.get(a)!)[0];
    groupOf.set(t, groupOf.get(best) ?? best);
    if (!groupOf.has(best)) groupOf.set(best, best);
  }
  const members = new Map<string, string[]>();
  for (const t of order) if (groupOf.has(t)) (members.get(groupOf.get(t)!) ?? members.set(groupOf.get(t)!, []).get(groupOf.get(t)!)!).push(t);
  // linked hubs that took no tables (company, company_group, company_type) form one group together
  for (const [hub, list] of [...members]) {
    if (list.length !== 1 || !members.has(hub)) continue;
    for (const n of near(hub)) {
      if (members.get(n)?.length !== 1 || n === hub) continue;
      list.push(n);
      members.delete(n);
      groupOf.set(n, hub);
    }
  }
  // a hub still alone joins the group it has the most links to (ties: the bigger hub)
  for (const [hub, list] of [...members]) {
    if (list.length !== 1) continue;
    const votes = new Map<string, number>();
    for (const n of near(hub)) {
      const g = groupOf.get(n);
      if (g && g !== hub) votes.set(g, (votes.get(g) ?? 0) + 1);
    }
    const target = [...votes].sort((a, b) => b[1] - a[1] || degree.get(b[0])! - degree.get(a[0])!)[0]?.[0];
    if (!target) continue;
    members.get(target)!.push(hub);
    members.delete(hub);
    groupOf.set(hub, target);
  }
  const groups: DiagramGroup[] = [...members].map(([hub, tables]) => ({ hub, tables: [hub, ...tables.filter((t) => t !== hub).sort()] }));
  groups.sort((a, b) => b.tables.length - a.tables.length || a.hub!.localeCompare(b.hub!));
  const lonely = names.filter((n) => !groupOf.has(n)).sort();
  if (lonely.length) groups.push({ hub: null, tables: lonely });
  return groups;
}

/**
 * Table name filter: `tbl_*`, `*_log`, `agenda*event`. Without `*` it matches names that contain the text.
 * Case does not matter.
 */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return () => true;
  if (!p.includes('*')) return (n) => n.toLowerCase().includes(p);
  const re = new RegExp(`^${p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (n) => re.test(n.toLowerCase());
}

/**
 * Common name parts as filters: `tbl_*` (prefix) and `*_log` (suffix) used by at least `min` tables,
 * most used first. A part every table has says nothing and is left out.
 */
export function nameAffixes(names: string[], min = 3, count = 12): { pattern: string; tables: number }[] {
  const counts = new Map<string, number>();
  for (const n of names) {
    const parts = n.toLowerCase().split('_');
    if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) continue;
    for (const key of new Set([`${parts[0]}_*`, `*_${parts[parts.length - 1]}`])) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= min && c < names.length)
    .map(([pattern, tables]) => ({ pattern, tables }))
    .sort((a, b) => b.tables - a.tables || a.pattern.localeCompare(b.pattern))
    .slice(0, count);
}
