import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useApp } from '../store/app';

export default function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="fade-in flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-[12.5px] shadow-[var(--shadow)]"
          role="status"
        >
          {t.kind === 'error' ? (
            <XCircle size={16} className="mt-px shrink-0 text-danger" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={16} className="mt-px shrink-0 text-success" />
          ) : (
            <Info size={16} className="mt-px shrink-0 text-ink-2" />
          )}
          <div className="selectable min-w-0 flex-1 whitespace-pre-line break-words text-ink">{t.message}</div>
          <button className="icon-btn -m-1 h-6 w-6" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
