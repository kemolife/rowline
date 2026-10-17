import { Component, type ReactNode } from 'react';
import { logClientError } from '../lib/api';

interface State {
  error: Error | null;
}

/** Shows the error instead of a blank window, and writes it to the client error log. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logClientError(`${error.name}: ${error.message}\n${error.stack ?? ''}\nComponent stack:${info.componentStack ?? ''}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n\n${error.stack ?? ''}`;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow)]">
          <div className="text-[15px] font-semibold">Something went wrong</div>
          <p className="mt-1 text-[13px] text-ink-2">The error was saved to the Rowline log. Your saved connections and tabs are safe.</p>
          <pre className="selectable mono mt-4 max-h-72 overflow-auto rounded-xl border border-line bg-bg p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-danger">{details}</pre>
          <div className="mt-4 flex gap-2">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(details)}>
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
