import { MySQL, PostgreSQL, SQLite, type SQLDialect } from '@codemirror/lang-sql';
import type { Engine } from './types';

/** CodeMirror SQL dialect of an engine (highlighting and keywords in the editor and the WHERE filter) */
export function codeMirrorDialect(e: Engine): SQLDialect {
  return e === 'mysql' ? MySQL : e === 'postgres' ? PostgreSQL : SQLite;
}
