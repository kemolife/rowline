import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Asks for the name of a saved query. */
export default function SaveQueryDialog({ initialName, onSave, onClose }: { initialName: string; onSave: (name: string) => Promise<void> | void; onClose: () => void }) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]" onMouseDown={onClose}>
      <form
        className="fade-in w-full max-w-[380px] rounded-2xl border border-line bg-surface shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          try {
            await onSave(name.trim());
          } finally {
            setBusy(false);
          }
        }}
        data-testid="save-query-dialog"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[13.5px] font-semibold">Save query</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <label className="block space-y-1.5 px-4 py-3.5">
          <span className="label">Name</span>
          <input className="field" value={name} placeholder="Top customers this month" onChange={(e) => setName(e.target.value)} autoFocus />
          <span className="block text-[11.5px] text-ink-3">Saved queries appear in the sidebar under Queries.</span>
        </label>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
