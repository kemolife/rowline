import { autocompletion } from '@codemirror/autocomplete';
import { MySQL, SQLite, sql as sqlLang } from '@codemirror/lang-sql';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { filterCompletionSource, filterCompletions, type FilterColumn } from '../lib/filterComplete';
import type { Engine } from '../lib/types';
import { useApp } from '../store/app';

export interface FilterInputHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  columns: FilterColumn[];
  engine: Engine;
  placeholder: string;
}

/** One-line SQL editor for the WHERE filter, with column / operator / function suggestions. */
const FilterInput = forwardRef<FilterInputHandle, Props>(function FilterInput({ value, onChange, onSubmit, onClear, columns, engine, placeholder }, ref) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const themeMode = useApp((s) => s.theme);
  useImperativeHandle(ref, () => ({ focus: () => editorRef.current?.view?.focus() }), []);

  // handlers and options change often; the extensions read them through refs so the editor is not rebuilt
  const latest = useRef({ onSubmit, onClear, options: [] as ReturnType<typeof filterCompletions> });
  latest.current.onSubmit = onSubmit;
  latest.current.onClear = onClear;
  const options = useMemo(() => filterCompletions(columns, engine), [columns, engine]);
  latest.current.options = options;

  const isDark = themeMode === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false) : themeMode === 'dark';

  const extensions = useMemo(
    () => [
      sqlLang({ dialect: engine === 'mysql' ? MySQL : SQLite }),
      autocompletion({ override: [filterCompletionSource(() => latest.current.options)], activateOnTyping: true, icons: true }),
      // single line: newlines from paste become spaces
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || !tr.newDoc.toString().includes('\n')) return tr;
        return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: tr.newDoc.toString().replace(/\s*\n\s*/g, ' ') }, sequential: true }];
      }),
      // above the default keymap (Enter would insert a line); the suggestion list keymap is higher still,
      // so Enter / Escape pick or close a suggestion first when the list is open
      Prec.high(
        keymap.of([
          { key: 'Enter', run: () => (latest.current.onSubmit(), true) },
          { key: 'Escape', run: () => (latest.current.onClear(), true) },
        ]),
      ),
      EditorView.theme({
        '&': { height: '100%', background: 'transparent !important', fontSize: '12px' },
        '.cm-scroller': { lineHeight: '26px !important', overflow: 'hidden' },
        '.cm-content': { padding: '0' },
        '.cm-line': { padding: '0' },
      }),
    ],
    [engine],
  );

  return (
    <CodeMirror
      ref={editorRef}
      className="filter-input h-full min-w-0 flex-1"
      value={value}
      onChange={onChange}
      height="26px"
      theme={isDark ? 'dark' : 'light'}
      extensions={extensions}
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        searchKeymap: false,
        defaultKeymap: true,
        history: true,
        closeBrackets: true,
      }}
      data-testid="filter-input"
    />
  );
});

export default FilterInput;
