import { isSqlExpr, type Cell, type Environment } from './types';

export const ENV_LABEL: Record<Environment, string> = { local: 'Local', dev: 'Dev', staging: 'Staging', prod: 'Production' };
export const envColor = (env: Environment) => `var(--env-${env})`;

export function formatCell(v: Cell): string {
  if (v === null) return 'NULL';
  if (isSqlExpr(v)) return v.$expr;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Key handling helper: matches "mod+s", "mod+shift+z", "escape" ... */
export function matchKey(e: KeyboardEvent | React.KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const mod = parts.includes('mod');
  const shift = parts.includes('shift');
  const alt = parts.includes('alt');
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  return (
    e.key.toLowerCase() === key &&
    modPressed === mod &&
    e.shiftKey === shift &&
    e.altKey === alt
  );
}

/**
 * `#4a7fc4` + 0.14 → `rgba(74, 127, 196, 0.14)`. The grid draws on a canvas, and the app's web view does not
 * understand `color-mix()` there (the selected cell turned black).
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return color;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Totals of selected cells (status line under a grid): count, and sum / avg / min / max of the numbers */
export function cellStats(values: unknown[]): { count: number; numbers: number; sum: number; avg: number; min: number; max: number } | null {
  if (values.length < 2) return null;
  let numbers = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    numbers++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return { count: values.length, numbers, sum, avg: numbers ? sum / numbers : 0, min, max };
}

/** 1234.5 → "1,234.5"; at most 4 decimals */
export const formatNumber = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
