import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import styles from './Toast.module.css';

/**
 * Design-system toast (Facilio DS "Feedback / Toast"): transient, non-blocking confirmation.
 * Semantic colour lives in the icon, the left hairline and the drain timer — never a full fill
 * (except error, which gets the subtle red wash and stays until dismissed). Stack is capped at 3
 * (enforced in the reducer); hovering a toast holds it; the 2px bottom bar drains over the
 * auto-dismiss window.
 */
export type ToastVariant = 'success' | 'warning' | 'error' | 'info';

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

const DUR_MS = 5000;

const ICONS: Record<ToastVariant, JSX.Element> = {
  success: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
    </svg>
  ),
  error: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistent = toast.variant === 'error'; // errors stay until dismissed

  useEffect(() => {
    if (!persistent) timer.current = setTimeout(() => onDismiss(toast.id), DUR_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  return (
    <div
      className={[styles.card, styles[toast.variant]].join(' ')}
      role="status"
      onMouseEnter={() => {
        if (timer.current) clearTimeout(timer.current);
      }}
      onMouseLeave={() => {
        if (!persistent) timer.current = setTimeout(() => onDismiss(toast.id), DUR_MS);
      }}
    >
      <div className={styles.icon}>{ICONS[toast.variant]}</div>
      <div className={styles.body}>
        <div className={styles.title}>{toast.title}</div>
        {toast.description && <div className={styles.desc}>{toast.description}</div>}
      </div>
      <button className={styles.close} aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
      {!persistent && <div className={styles.drain} style={{ animationDuration: `${DUR_MS}ms` }} />}
    </div>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className={styles.host}>
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
