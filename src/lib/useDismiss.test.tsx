import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useDismiss, type DismissReason } from './useDismiss';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

function mount(onClose: (r: DismissReason) => void, closeOnBlur: boolean) {
  function Popover() {
    const ref = useRef<HTMLDivElement>(null);
    useDismiss(ref, onClose, true, closeOnBlur);
    return <div ref={ref} id="inside" />;
  }
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(<Popover />));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
}

it('a form stays open when the window loses focus (switching apps to copy a value)', () => {
  const onClose = vi.fn();
  mount(onClose, false);
  window.dispatchEvent(new Event('blur'));
  expect(onClose).not.toHaveBeenCalled();
  document.getElementById('inside')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(onClose).not.toHaveBeenCalled();
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(onClose).toHaveBeenCalledWith('outside');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(onClose).toHaveBeenLastCalledWith('escape');
});

it('menus still close on window blur', () => {
  const onClose = vi.fn();
  mount(onClose, true);
  window.dispatchEvent(new Event('blur'));
  expect(onClose).toHaveBeenCalledWith('blur');
});
