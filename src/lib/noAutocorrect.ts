/**
 * Turns off the system spelling correction in every text field of the app: table names, column names,
 * SQL and cell values are not words, and macOS autocorrect would change them while you type.
 * Works for fields that appear later too (popovers, the grid's cell editor): it runs on focus.
 */
export function disableAutocorrect(root: Document = document) {
  const off = (el: EventTarget | null) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable))) return;
    el.spellcheck = false;
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    if (!(el instanceof HTMLElement && el.isContentEditable) && !el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
  };
  const onFocus = (e: FocusEvent) => off(e.target);
  root.addEventListener('focusin', onFocus, true);
  return () => root.removeEventListener('focusin', onFocus, true);
}
