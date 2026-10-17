import { useEffect, type RefObject } from 'react';

/**
 * Closes a floating element (menu, popover) on a click outside it, scroll, Escape or window blur.
 * Uses pointerdown in the capture phase: the data grid cancels pointer events, so no mousedown would follow.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', esc);
    };
  }, [ref, onClose, active]);
}
