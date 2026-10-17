import { describe, expect, it } from 'vitest';
import { toEditorStatements } from './statementGutter';

describe('statement positions', () => {
  it('turns character offsets into editor offsets, emoji included', () => {
    const doc = "SELECT '😀';\nSELECT 2;";
    // backend counts the emoji as one character
    const ranges = [
      { start: 0, end: 10, text: "SELECT '😀'" },
      { start: 12, end: 20, text: 'SELECT 2' },
    ];
    const out = toEditorStatements(doc, ranges);
    expect(doc.slice(out[0].from, out[0].to)).toBe("SELECT '😀'");
    expect(doc.slice(out[1].from, out[1].to)).toBe('SELECT 2');
  });
});
