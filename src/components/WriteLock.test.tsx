import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const answer = { value: false };
vi.mock('../lib/api', () => ({ confirmDialog: vi.fn(async () => answer.value) }));

import { confirmDialog } from '../lib/api';
import WriteLock from './WriteLock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('asks before unlocking, names the connection and database, and shows the unlocked state', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onUnlock = vi.fn();
  const render = (unlocked: boolean) => act(() => root.render(<WriteLock unlocked={unlocked} connection="shop-prod" database="shop" onUnlock={onUnlock} />));
  render(false);
  expect(host.querySelector('[data-testid=write-lock]')?.textContent).toContain('Read-only (prod)');
  expect(host.querySelector('[data-testid=writes-unlocked]')).toBeNull();

  // "no": stays locked
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=unlock-writes]')!.click());
  expect(confirmDialog).toHaveBeenCalledWith('Allow changes to shop-prod / shop in this tab? Other tabs, Claude and udb stay read-only.', { title: 'Unlock writes', danger: true });
  expect(onUnlock).not.toHaveBeenCalled();

  answer.value = true;
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=unlock-writes]')!.click());
  expect(onUnlock).toHaveBeenCalledTimes(1);

  render(true);
  expect(host.querySelector('[data-testid=writes-unlocked]')?.textContent).toContain('Writes unlocked');
  expect(host.querySelector('[data-testid=unlock-writes]')).toBeNull();
  act(() => root.unmount());
  host.remove();
});
