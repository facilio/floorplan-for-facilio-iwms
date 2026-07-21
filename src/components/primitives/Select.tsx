import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import styles from './Select.module.css';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string = string> {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  'aria-label'?: string;
}

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** Listbox opens upward, bottom-anchored to the trigger (translateY(-100%)). */
  up: boolean;
}

function computePlacement(trigger: HTMLElement): Placement {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.max(rect.width, 168);
  const left = Math.min(Math.max(rect.left, 8), vw - width - 8);
  const spaceBelow = vh - rect.bottom - 12;
  const spaceAbove = rect.top - 12;
  // Flip upward when there's no room below (triggers near the bottom of the
  // viewport — e.g. inside the mobile bottom sheet, where a downward listbox
  // rendered entirely off-screen).
  if (spaceBelow < 170 && spaceAbove > spaceBelow) {
    return { left, top: rect.top - 5, width, maxHeight: Math.max(120, spaceAbove - 5), up: true };
  }
  return { left, top: rect.bottom + 5, width, maxHeight: Math.max(150, spaceBelow), up: false };
}

/**
 * Custom-styled single-select dropdown. Renders nothing like a native <select> —
 * a button trigger plus a floating, keyboard-navigable listbox — so it looks
 * consistent across browsers and themes. The listbox is portaled to <body> and
 * positioned `fixed` from the trigger's own bounding rect (clamped to the
 * viewport) rather than absolutely inside its parent — this component is used
 * inside several scrollable, overflow-clipped panels, and an absolutely
 * positioned dropdown would get cut off/hidden by the panel's own overflow.
 */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  size = 'md',
  fullWidth,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function reposition() {
      if (triggerRef.current) setPlacement(computePlacement(triggerRef.current));
    }
    function onDocDown(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    reposition();
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
      listRef.current?.focus();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex);
    }
  }

  return (
    <div ref={rootRef} className={[styles.root, fullWidth ? styles.fullWidth : ''].join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        className={[styles.trigger, styles[size], open ? styles.triggerOpen : ''].join(' ')}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.value}>
          {selected ? selected.label : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <svg
          className={styles.chevron}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open &&
        placement &&
        createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            className={styles.listbox}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
            style={{
              position: 'fixed',
              left: placement.left,
              top: placement.top,
              width: placement.width,
              maxHeight: placement.maxHeight,
              transform: placement.up ? 'translateY(-100%)' : undefined,
            }}
          >
            {options.map((opt, i) => (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                className={[
                  styles.option,
                  i === activeIndex ? styles.optionActive : '',
                  opt.value === value ? styles.optionSelected : '',
                  opt.disabled ? styles.optionDisabled : '',
                ].join(' ')}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
              >
                <span className={styles.optionLabel}>
                  <span>{opt.label}</span>
                  {opt.sublabel && <span className={styles.optionSub}>{opt.sublabel}</span>}
                </span>
                {opt.value === value && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}
