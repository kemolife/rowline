/**
 * Turns off the system spelling correction in every text field of the app: table names, column names,
 * SQL and cell values are not words, and macOS autocorrect would change them while you type.
 * The attributes are set as soon as a field is added to the page (WebKit reads them when the field gets focus,
 * so they must be there before that), and again on focus as a backup.
 */
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isField(el: unknown): el is Field {
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type);
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

function off(el: Field) {
  if (el.getAttribute('autocorrect') === 'off' && !el.spellcheck) return;
  el.spellcheck = false;
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  if (!el.isContentEditable && !el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
}

function offAll(node: Node) {
  if (isField(node)) off(node);
  if (node instanceof Element || node instanceof Document) {
    node.querySelectorAll<HTMLElement>('input, textarea, [contenteditable]').forEach((el) => isField(el) && off(el));
  }
}

export function disableAutocorrect(root: Document = document) {
  const onFocus = (e: FocusEvent) => isField(e.target) && off(e.target);
  root.addEventListener('focusin', onFocus, true);
  offAll(root);
  const obs = new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach(offAll)));
  obs.observe(root, { childList: true, subtree: true });
  return () => {
    root.removeEventListener('focusin', onFocus, true);
    obs.disconnect();
  };
}
