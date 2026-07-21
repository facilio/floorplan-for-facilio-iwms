import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import styles from './FloatingPanel.module.css';

interface FloatingPanelProps {
  x: number;
  y: number;
  open: boolean;
  width: number;
  maxHeight: number;
  title: ReactNode;
  icon: ReactNode;
  onHeaderDown: (e: ReactMouseEvent) => void;
  onToggle: (e: ReactMouseEvent) => void;
  onIconDown: (e: ReactMouseEvent) => void;
  onIconClick: () => void;
  children: ReactNode;
  translucent?: boolean;
  zIndex?: number;
}

/** A draggable, collapsible floating panel used for Location and Details on the canvas. */
export function FloatingPanel({
  x,
  y,
  open,
  width,
  maxHeight,
  title,
  icon,
  onHeaderDown,
  onToggle,
  onIconDown,
  onIconClick,
  children,
  translucent,
  zIndex = 41,
}: FloatingPanelProps) {
  if (!open) {
    return (
      <div
        className={styles.iconDock}
        style={{ left: x, top: y, zIndex }}
        onMouseDown={onIconDown}
        onClick={onIconClick}
        title={typeof title === 'string' ? `Open ${title}` : undefined}
      >
        {icon}
      </div>
    );
  }
  return (
    <div
      className={[styles.panel, translucent ? styles.translucent : ''].join(' ')}
      style={{ left: x, top: y, width, maxHeight, zIndex }}
    >
      <div className={styles.header} onMouseDown={onHeaderDown}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="6" r="1" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="9" cy="18" r="1" />
          <circle cx="15" cy="6" r="1" />
          <circle cx="15" cy="12" r="1" />
          <circle cx="15" cy="18" r="1" />
        </svg>
        <span className={styles.title}>{title}</span>
        <button className={styles.collapse} title="Collapse" onClick={onToggle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
