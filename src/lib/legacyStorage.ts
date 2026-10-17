/** The app was called Tabula: moves its saved UI state (theme, open tabs, panel widths) to the new keys, once. */
export function moveLegacyKeys(storage: Storage): void {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith('tabula.')) old.push(key);
  }
  for (const key of old) {
    const next = `rowline.${key.slice('tabula.'.length)}`;
    const value = storage.getItem(key);
    if (value != null && storage.getItem(next) == null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}

// runs on import, before the stores read their keys (main.tsx imports this first)
try {
  moveLegacyKeys(localStorage);
} catch {
  /* storage blocked: nothing to move */
}
