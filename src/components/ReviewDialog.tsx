import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { Environment } from '../lib/types';
import { ENV_LABEL, envColor } from '../lib/ui';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function ReviewDialog({
  statements,
  environment,
  connectionName,
  database,
  busy,
  onApply,
  onClose,
}: {
  statements: string[];
  environment: Environment;
  connectionName: string;
  database: string | null;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const production = environment === 'prod';
  const color = envColor(environment);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onApply();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onApply, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="fade-in flex max-h-[80vh] w-full max-w-[760px] flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()} data-testid="review-dialog">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <div className="text-[14px] font-semibold">Review changes</div>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-3" data-testid="review-target">
              <span className="rounded px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide text-white" style={{ background: color }}>
                {ENV_LABEL[environment]}
              </span>
              <span className="font-medium text-ink-2">{connectionName}</span>
              {database && (
                <>
                  <span>·</span>
                  <span className="mono text-ink-2">{database}</span>
                </>
              )}
              <span>·</span>
              <span>
                {statements.length} statement{statements.length === 1 ? '' : 's'} · run in one transaction
              </span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {production && (
          <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <AlertTriangle size={15} /> This is a production connection.
          </div>
        )}
        <pre
          className="selectable mono m-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line border-l-[3px] bg-bg p-3.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink"
          style={{ borderLeftColor: color }}
        >
          {statements.map((s) => `${s};`).join('\n')}
        </pre>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={production ? 'btn btn-primary !bg-danger !border-danger' : 'btn btn-primary'} onClick={onApply} disabled={busy} autoFocus>
            {busy && <Loader2 size={14} className="animate-spin" />} {production ? 'Apply to production' : 'Apply changes'}
            <span className="opacity-70">⌘↵</span>
          </button>
        </div>
      </div>
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}
