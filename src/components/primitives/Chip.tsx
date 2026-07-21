import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Chip.module.css';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  count?: number;
  children: ReactNode;
}

export function Chip({ active, count, className, children, ...rest }: ChipProps) {
  const cls = [styles.chip, active ? styles.active : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {children}
      {count != null && <span className={styles.count}>{count}</span>}
    </button>
  );
}
