import { useEffect, type RefObject } from 'react';

export type DismissReason = 'outside' | 'escape' | 'blur';

/**
 * Closes a floating element (menu, popover) on a click outside it, scroll, Escape or window blur.
 * Uses pointerdown in the capture phase: the data grid cancels pointer events, so no mousedown would follow.
 * Forms pass `closeOnBlur = false`: switching to another app to copy something must not close them.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: (reason: DismissReason) => void, active = true, closeOnBlur = true) {
  useEffect(() => {
    if (!active) return;
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose('outside');
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose('escape');
    const blur = () => onClose('blur');
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, true);
    if (closeOnBlur) window.addEventListener('blur', blur);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', esc);
    };
  }, [ref, onClose, active, closeOnBlur]);
}
