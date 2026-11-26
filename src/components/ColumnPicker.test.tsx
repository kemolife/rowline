import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ColumnPicker from './ColumnPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout
Element.prototype.scrollIntoView ??= () => {};

const columns = Array.from({ length: 60 }, (_, i) => ({ name: `col_${i}`, type: 'int' })).concat([{ name: 'user_id', type: 'bigint' }]);

it('typing finds a column in a wide table, Enter picks it, Esc closes only the list', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onPicked = vi.fn();
  const escHits = vi.fn();
  const windowEsc = (e: KeyboardEvent) => e.key === 'Escape' && escHits();
  window.addEventListener('keydown', windowEsc);
  act(() => root.render(<ColumnPicker columns={columns} value="col_0" onChange={onChange} onPicked={onPicked} autoFocus ariaLabel="Column" />));
  const input = host.querySelector('input')!;
  expect(document.activeElement).toBe(input);
  expect(host.querySelectorAll('[role=option]')).toHaveLength(61);

  const type = (text: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const key = (k: string) => act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

  type('user');
  expect([...host.querySelectorAll('[role=option]')].map((o) => o.textContent)).toEqual(['user_idbigint']);
  key('Enter');
  expect(onChange).toHaveBeenCalledWith('user_id');
  expect(onPicked).toHaveBeenCalled();

  key('ArrowDown');
  expect(host.querySelector('[role=listbox]')).not.toBeNull();
  key('Escape');
  expect(host.querySelector('[role=listbox]')).toBeNull();
  expect(escHits).not.toHaveBeenCalled();

  window.removeEventListener('keydown', windowEsc);
  act(() => root.unmount());
  host.remove();
});
