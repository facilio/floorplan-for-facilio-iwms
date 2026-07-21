import { useState } from 'react';
import styles from './Picklist.module.css';

export interface PicklistOption<T extends string> {
  value: T;
  label: string;
  /** Secondary line under the label (e.g. "assignable, not bookable"). */
  description?: string;
  /** Optional status dot color (CSS value) shown before the label. */
  dot?: string;
}

interface PicklistProps<T extends string> {
  value: T | null;
  options: PicklistOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  'aria-label'?: string;
}

/**
 * Facilio Design System single-select picklist (FDS gallery Canvas-2.dc.html → Selection).
 * A styled trigger + popover — NOT a native `<select>` — with an optional status dot, a rotating
 * chevron, and a checkmark on the chosen row. Closes on outside click via a full-viewport scrim.
 */
export function Picklist<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Select an option',
  disabled,
  fullWidth = true,
  'aria-label': ariaLabel,
}: PicklistProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;

  function choose(v: T) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div className={[styles.wrap, fullWidth ? styles.fullWidth : ''].join(' ')}>
      {label && <div className={styles.label}>{label}</div>}
      {open && <div className={styles.scrim} onClick={() => setOpen(false)} />}
      <button
        type="button"
        className={[styles.trigger, open ? styles.open : ''].join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className={styles.triggerText}>
          {selected ? (
            <>
              {selected.dot && <span className={styles.dot} style={{ background: selected.dot }} />}
              <span className={styles.value}>{selected.label}</span>
            </>
          ) : (
            <span className={styles.placeholder}>{placeholder}</span>
          )}
        </span>
        <svg
          className={[styles.chevron, open ? styles.up : ''].join(' ')}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={styles.menu} role="listbox">
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                className={[styles.option, on ? styles.selected : ''].join(' ')}
                onClick={() => choose(o.value)}
              >
                {o.dot && <span className={styles.dot} style={{ background: o.dot }} />}
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{o.label}</span>
                  {o.description && <span className={styles.optionDesc}>{o.description}</span>}
                </span>
                {on && (
                  <svg className={styles.check} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
