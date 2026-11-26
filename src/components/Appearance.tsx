import { Moon, Sun, SunMoon } from 'lucide-react';
import { cx } from '../lib/ui';
import { useApp } from '../store/app';

/** A small row of choices with the current one highlighted. */
export function Segmented<T extends string>({ label, value, onChange, options, testId }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; icon: React.ReactNode }[]; testId: string }) {
  return (
    <div className="flex items-center rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={cx('flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px]', o.value === value ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}
          onClick={() => onChange(o.value)}
          title={`${label}: ${o.label}`}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Style (Blue / Warm) and appearance (Light / Dark / System). Every choice is visible and the current one
 * is highlighted: a single button showed the current mode and read like "switch to". Used on the start
 * screen and in the "More actions" menu of a connection.
 */
export default function AppearanceSwitches({ stacked = false }: { stacked?: boolean }) {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const colorStyle = useApp((s) => s.colorStyle);
  const setColorStyle = useApp((s) => s.setColorStyle);
  const style = (
    <Segmented
      label="Style"
      value={colorStyle}
      onChange={setColorStyle}
      options={[
        { value: 'blue', label: 'Blue', icon: <span className="h-2.5 w-2.5 rounded-full bg-[#3a6db5]" /> },
        { value: 'warm', label: 'Warm', icon: <span className="h-2.5 w-2.5 rounded-full bg-[#c96442]" /> },
      ]}
      testId="style-switch"
    />
  );
  const mode = (
    <Segmented
      label="Appearance"
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'light', label: 'Light', icon: <Sun size={13} /> },
        { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
        { value: 'system', label: 'System', icon: <SunMoon size={13} /> },
      ]}
      testId="theme-switch"
    />
  );
  if (!stacked)
    return (
      <>
        {style}
        {mode}
      </>
    );
  return (
    <div className="space-y-1.5 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-3">Style</span>
        {style}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-3">Mode</span>
        {mode}
      </div>
    </div>
  );
}
