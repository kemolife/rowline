import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import type { StatementRange } from './types';

/** A statement in editor positions (UTF-16 offsets) */
export interface EditorStatement {
  from: number;
  to: number;
  text: string;
}

/** Backend ranges count characters (code points); CodeMirror counts UTF-16 units. */
export function toEditorStatements(doc: string, ranges: StatementRange[]): EditorStatement[] {
  const chars = [...doc];
  const offsets: number[] = new Array(chars.length + 1);
  let pos = 0;
  for (let i = 0; i < chars.length; i++) {
    offsets[i] = pos;
    pos += chars[i].length;
  }
  offsets[chars.length] = pos;
  const at = (i: number) => offsets[Math.max(0, Math.min(i, chars.length))];
  return ranges.map((r) => ({ from: at(r.start), to: at(r.end), text: r.text }));
}

export const setStatements = StateEffect.define<EditorStatement[]>();

export const statementsField = StateField.define<EditorStatement[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStatements)) return e.value;
    if (!tr.docChanged) return value;
    // keep markers in place while typing; the next split replaces them
    return value.map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) }));
  },
});

class RunMarker extends GutterMarker {
  constructor(readonly index: number) {
    super();
  }
  eq(other: RunMarker) {
    return other.index === this.index;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-run-marker';
    el.textContent = '▶';
    el.title = 'Run this statement';
    return el;
  }
}

/** Highlights the statement the cursor is in */
const currentStatement = EditorView.decorations.compute([statementsField, 'selection'], (state) => {
  const head = state.selection.main.head;
  const list = state.field(statementsField);
  const hit = list.find((s) => head >= s.from && head <= s.to + 1);
  if (!hit || list.length < 2) return Decoration.none as DecorationSet;
  const mark = Decoration.line({ class: 'cm-current-statement' });
  const deco = [];
  for (let line = state.doc.lineAt(hit.from).number; line <= state.doc.lineAt(Math.min(hit.to, state.doc.length)).number; line++) {
    deco.push(mark.range(state.doc.line(line).from));
  }
  return Decoration.set(deco);
});

/** ▶ in the gutter at the first line of every statement; clicking it runs that statement */
export function statementGutter(onRun: (s: EditorStatement) => void): Extension {
  return [
    statementsField,
    currentStatement,
    gutter({
      class: 'cm-run-gutter',
      markers: (view) => {
        const list = view.state.field(statementsField);
        const seen = new Set<number>();
        const markers = list
          .map((s, i) => {
            const line = view.state.doc.lineAt(Math.min(s.from, view.state.doc.length));
            // leading blank lines or comments: put the marker on the first line with text
            let target = line;
            while (target.number < view.state.doc.lines && !target.text.trim()) target = view.state.doc.line(target.number + 1);
            if (seen.has(target.from)) return null;
            seen.add(target.from);
            return new RunMarker(i).range(target.from);
          })
          .filter((m): m is NonNullable<typeof m> => m !== null);
        return RangeSet.of(markers, true);
      },
      domEventHandlers: {
        mousedown(view, line) {
          const list = view.state.field(statementsField);
          const hit = list.find((s) => {
            const first = view.state.doc.lineAt(Math.min(s.from, view.state.doc.length));
            let target = first;
            while (target.number < view.state.doc.lines && !target.text.trim()) target = view.state.doc.line(target.number + 1);
            return target.from === line.from;
          });
          if (!hit) return false;
          onRun(hit);
          return true;
        },
      },
    }),
  ];
}
