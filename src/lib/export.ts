import { api, isTauri } from './api';
import { cellLiteral, quoteIdent } from './filters';
import { isSqlExpr, type Cell, type Engine, type ResultColumn } from './types';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'sql' | 'text';

export const EXPORT_FORMATS: { format: ExportFormat; label: string; ext: string }[] = [
  { format: 'csv', label: 'CSV', ext: 'csv' },
  { format: 'tsv', label: 'TSV (Excel paste)', ext: 'tsv' },
  { format: 'json', label: 'JSON', ext: 'json' },
  { format: 'markdown', label: 'Markdown table', ext: 'md' },
  { format: 'sql', label: 'SQL INSERT', ext: 'sql' },
  { format: 'text', label: 'Text table', ext: 'txt' },
];

const plain = (v: Cell): string => (v === null ? '' : isSqlExpr(v) ? v.$expr : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

function csvEscape(v: Cell): string {
  if (v === null) return '';
  const s = plain(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ResultColumn[], rows: Cell[][]): string {
  return [columns.map((c) => csvEscape(c.name)).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

/** Tab separated; tabs and newlines inside values become spaces so a paste into a spreadsheet keeps its shape */
export function toTsv(columns: ResultColumn[], rows: Cell[][]): string {
  const f = (v: Cell) => plain(v).replace(/[\t\r\n]+/g, ' ');
  return [columns.map((c) => f(c.name)).join('\t'), ...rows.map((r) => r.map(f).join('\t'))].join('\n') + '\n';
}

export function toJson(columns: ResultColumn[], rows: Cell[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))), null, 2) + '\n';
}

export function toMarkdown(columns: ResultColumn[], rows: Cell[][]): string {
  const f = (v: Cell) => (v === null ? 'NULL' : plain(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
  const head = `| ${columns.map((c) => f(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.map(f).join(' | ')} |`)].join('\n') + '\n';
}

/** One INSERT per 100 rows */
export function toSqlInsert(columns: ResultColumn[], rows: Cell[][], table: string, engine: Engine): string {
  if (!rows.length) return '';
  const cols = columns.map((c) => quoteIdent(engine, c.name)).join(', ');
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const values = rows
      .slice(i, i + 100)
      .map((r) => `  (${r.map((v) => cellLiteral(engine, v)).join(', ')})`)
      .join(',\n');
    out.push(`INSERT INTO ${quoteIdent(engine, table)} (${cols}) VALUES\n${values};`);
  }
  return out.join('\n\n') + '\n';
}

/** Fixed-width text table, like the mysql command line client */
export function toTextTable(columns: ResultColumn[], rows: Cell[][]): string {
  const f = (v: Cell) => (v === null ? 'NULL' : plain(v).replace(/\r?\n/g, '↵'));
  const cells = rows.map((r) => r.map(f));
  const widths = columns.map((c, i) => Math.min(60, Math.max(c.name.length, ...cells.map((r) => r[i].length))));
  const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
  const line = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const row = (vals: string[]) => `| ${vals.map((v, i) => fit(v, widths[i])).join(' | ')} |`;
  return [line, row(columns.map((c) => c.name)), line, ...cells.map(row), line].join('\n') + '\n';
}

export function formatRows(format: ExportFormat, columns: ResultColumn[], rows: Cell[][], table: string, engine: Engine): string {
  switch (format) {
    case 'csv':
      return toCsv(columns, rows);
    case 'tsv':
      return toTsv(columns, rows);
    case 'json':
      return toJson(columns, rows);
    case 'markdown':
      return toMarkdown(columns, rows);
    case 'sql':
      return toSqlInsert(columns, rows, table, engine);
    case 'text':
      return toTextTable(columns, rows);
  }
}

/**
 * Text to paste into a chat with Claude: the query and its result as a Markdown table
 * (JSON when there are many columns), at most `maxRows` rows.
 */
export function forClaude(sql: string | null, columns: ResultColumn[], rows: Cell[][], maxRows = 50): string {
  const shown = rows.slice(0, maxRows);
  const body = columns.length > 12 ? '```json\n' + toJson(columns, shown) + '```' : toMarkdown(columns, shown).trimEnd();
  const more = rows.length > shown.length ? `\n\n(${shown.length} of ${rows.length} rows shown)` : '';
  const query = sql ? '```sql\n' + sql.trim() + '\n```\n\n' : '';
  return `${query}Result (${rows.length} row${rows.length === 1 ? '' : 's'}):\n\n${body}${more}\n`;
}

/** Table name to use for SQL INSERT export: the first FROM table of a query, else `result` */
export function guessTable(sql: string | null): string {
  const m = sql?.match(/\bfrom\s+[`"[]?([\w$]+)[`"\]]?(?:\s*\.\s*[`"[]?([\w$]+)[`"\]]?)?/i);
  return m ? (m[2] ?? m[1]) : 'result';
}

/** Saves rows in the format the user picks (by file type in the save dialog). */
export async function exportRows(
  name: string,
  columns: ResultColumn[],
  rows: Cell[][],
  toast: (m: string, k?: 'info' | 'success' | 'error') => void,
  opts: { format?: ExportFormat; table?: string; engine?: Engine } = {},
) {
  const table = opts.table ?? name;
  const engine = opts.engine ?? 'mysql';
  try {
    if (isTauri) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const first = EXPORT_FORMATS.find((f) => f.format === (opts.format ?? 'csv'))!;
      const path = await save({
        defaultPath: `${name}.${first.ext}`,
        filters: [first, ...EXPORT_FORMATS.filter((f) => f !== first)].map((f) => ({ name: f.label, extensions: [f.ext] })),
      });
      if (!path) return;
      const ext = path.split('.').pop()?.toLowerCase();
      const format = EXPORT_FORMATS.find((f) => f.ext === ext)?.format ?? first.format;
      await api.writeTextFile(path, formatRows(format, columns, rows, table, engine));
      toast(`Exported ${rows.length} rows to ${path.split('/').pop()}`, 'success');
    } else {
      const format = opts.format ?? 'csv';
      const ext = EXPORT_FORMATS.find((f) => f.format === format)!.ext;
      const blob = new Blob([formatRows(format, columns, rows, table, engine)], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}
