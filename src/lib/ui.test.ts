import { describe, expect, it } from 'vitest';
import { cellStats, formatNumber, shortCount, withAlpha } from './ui';

describe('canvas colors', () => {
  it('turns hex colors into rgba (the canvas does not understand color-mix)', () => {
    expect(withAlpha('#4a7fc4', 0.16)).toBe('rgba(74, 127, 196, 0.16)');
    expect(withAlpha(' #fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });

  it('sums selected cells, counting only numbers', () => {
    expect(cellStats([1])).toBeNull();
    expect(cellStats([10, '2.5', 'abc', null, -1])).toEqual({ count: 5, numbers: 3, sum: 11.5, avg: 11.5 / 3, min: -1, max: 10 });
    expect(cellStats(['a', 'b'])).toMatchObject({ count: 2, numbers: 0 });
    expect(formatNumber(1234.56789)).toBe('1,234.5679');
  });
});

describe('shortCount', () => {
  it('shortens big row counts', () => {
    expect(shortCount(263)).toBe('263');
    expect(shortCount(830540)).toBe('830.5K');
    expect(shortCount(43131938)).toBe('43.1M');
    expect(shortCount(2000)).toBe('2K');
  });
});
