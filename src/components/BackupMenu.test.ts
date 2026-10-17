import { describe, expect, it } from 'vitest';
import { backupFileName } from './BackupMenu';

describe('backup file names', () => {
  it('use the database name and a time stamp', () => {
    const at = new Date(2026, 9, 16, 9, 5);
    expect(backupFileName('shop', at)).toBe('shop-2026-10-16-0905');
    expect(backupFileName('my app.sqlite', at)).toBe('my_app-2026-10-16-0905');
    expect(backupFileName('', at)).toBe('database-2026-10-16-0905');
  });
});
