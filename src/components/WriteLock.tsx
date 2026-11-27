import { Lock, LockOpen } from 'lucide-react';
import { confirmDialog } from '../lib/api';
import { unlockQuestion } from '../lib/engine';

/** Why edit controls are off in a locked tab (tooltip) */
export const LOCKED_HINT = 'Read-only: this is a production PostgreSQL connection. Use "Unlock writes" in this tab to change data.';

/**
 * Prod Postgres tab toolbar: a neutral "Read-only (prod)" pill with "Unlock writes", or a red "Writes unlocked" pill.
 * The unlock asks first and holds for this tab only, until it closes.
 */
export default function WriteLock({ unlocked, connection, database, onUnlock }: { unlocked: boolean; connection: string; database: string | null; onUnlock: () => void }) {
  if (unlocked) {
    return (
      <span
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-danger-soft px-2 text-[11.5px] font-medium text-danger"
        title="This tab can change data on a production connection. Other tabs, Claude and udb stay read-only. Closing the tab locks it again."
        data-testid="writes-unlocked"
      >
        <LockOpen size={12} /> Writes unlocked
      </span>
    );
  }
  const unlock = async () => {
    if (await confirmDialog(unlockQuestion(connection, database), { title: 'Unlock writes', danger: true })) onUnlock();
  };
  return (
    <span className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface-2 pl-2 pr-0.5 text-[11.5px] text-ink-2" data-testid="write-lock" title={LOCKED_HINT}>
      <Lock size={11} className="text-ink-3" /> <span className="@max-[800px]:hidden">Read-only (prod)</span>
      <button className="ml-0.5 h-5 rounded-full px-2 font-medium text-ink hover:bg-surface-3" onClick={unlock} data-testid="unlock-writes" title="Allow changes in this tab only (asks first)">
        <span className="@max-[560px]:hidden">Unlock writes</span>
        <span className="hidden @max-[560px]:inline">Unlock</span>
      </button>
    </span>
  );
}
