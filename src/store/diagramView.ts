import { create } from 'zustand';
import type { DiagramGroup, Relation } from '../lib/diagram';
import type { TableView } from '../lib/schemaDiff';

/** What the sidebar can ask an open diagram to do */
export interface DiagramActions {
  /** select a table and move the view to it; null clears the selection */
  pin: (name: string | null) => void;
  open: (name: string, view: 'data' | 'structure') => void;
  /** open the "Ask Claude" bar for the selected table */
  ask: () => void;
  saveGuess: (r: Relation) => void;
  removeVirtual: (r: Relation) => void;
  /** focus mode: also show the tables this one links to */
  expand: (name: string) => void;
  /** show only tables whose name matches (`tbl_*`); null shows all again */
  filterByName: (pattern: string | null) => void;
}

/** An open diagram as the sidebar outline shows it */
export interface DiagramOutline {
  /** tables on the diagram */
  tables: TableView[];
  /** every table of the database (search also finds hidden ones) */
  allTables: TableView[];
  relations: Relation[];
  groups: DiagramGroup[];
  /** group colour of each table on the diagram */
  colors: ReadonlyMap<string, string>;
  /** the selected table */
  pinned: string | null;
  /** focus mode tables that can still show their neighbours */
  expandable: ReadonlySet<string>;
  /** the name filter in use */
  namePattern: string | null;
  actions: DiagramActions;
}

interface DiagramViewState {
  /** by diagram tab id */
  outlines: Record<string, DiagramOutline>;
  /** table under the mouse, on the diagram or in the outline */
  hover: Record<string, string | null>;
  /** outline search: matching tables stay bright on the diagram */
  query: Record<string, string>;
  publish: (tabId: string, outline: DiagramOutline) => void;
  drop: (tabId: string) => void;
  setHover: (tabId: string, name: string | null) => void;
  setQuery: (tabId: string, q: string) => void;
}

/** Shared state between a diagram tab and the sidebar outline next to it */
export const useDiagramView = create<DiagramViewState>((set) => ({
  outlines: {},
  hover: {},
  query: {},
  publish: (tabId, outline) => set((s) => ({ outlines: { ...s.outlines, [tabId]: outline } })),
  drop: (tabId) =>
    set((s) => {
      const { [tabId]: _o, ...outlines } = s.outlines;
      const { [tabId]: _h, ...hover } = s.hover;
      const { [tabId]: _q, ...query } = s.query;
      return { outlines, hover, query };
    }),
  setHover: (tabId, name) => set((s) => (s.hover[tabId] === name ? s : { hover: { ...s.hover, [tabId]: name } })),
  setQuery: (tabId, q) => set((s) => ({ query: { ...s.query, [tabId]: q } })),
}));
