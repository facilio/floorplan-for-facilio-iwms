import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Keeps ONE broken surface from taking the whole app down (requested). A render error inside a
 * details popup, a panel or a modal unmounts the React tree above it — that is how a hooks-order
 * mistake once turned into a blank screen in the deployed app. Here the error is reported to the
 * caller (which toasts it) and the boundary renders a small notice in place of the surface, so
 * everything around it keeps working.
 *
 * Resets when `resetKey` changes — selecting a different unit retries rather than staying broken.
 */
interface Props {
  children: ReactNode;
  /** Reported once per error — the caller shows the toast (this class can't use hooks). */
  onError?: (message: string) => void;
  /** What the user was looking at, for the message: "Couldn't show {label}". */
  label?: string;
  /** Change this to clear the error and try rendering again. */
  resetKey?: string | number | null;
  /** Render nothing at all instead of the inline notice (for overlays like a popup). */
  silent?: boolean;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(err: unknown): State {
    return { message: (err as Error)?.message || 'Unexpected error' };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[error-boundary] ${this.props.label ?? 'surface'} failed`, err, info?.componentStack);
    this.props.onError?.((err as Error)?.message || 'Unexpected error');
  }

  componentDidUpdate(prev: Props) {
    if (this.state.message && prev.resetKey !== this.props.resetKey) this.setState({ message: null });
  }

  render() {
    if (!this.state.message) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div
        role="alert"
        style={{
          // Sized to its content: as a flex child it stretched to the full view height and read
          // as a giant empty pink panel.
          alignSelf: 'flex-start',
          height: 'fit-content',
          maxWidth: 460,
          border: '1px solid #f0bcbc',
          borderLeft: '3px solid #c62828',
          background: '#fdf2f2',
          color: '#8f2323',
          borderRadius: 8,
          padding: '10px 12px',
          margin: 8,
          font: '500 12.5px/1.45 var(--font-sans)',
        }}
      >
        Couldn’t show {this.props.label ?? 'this'} — {this.state.message}
      </div>
    );
  }
}
