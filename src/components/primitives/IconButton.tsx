import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: number;
  children: ReactNode;
}

export function IconButton({ active, size = 34, className, style, children, ...rest }: IconButtonProps) {
  const cls = [styles.btn, active ? styles.active : '', className].filter(Boolean).join(' ');
  return (
    <button className={cls} style={{ width: size, height: size, ...style }} {...rest}>
      {children}
    </button>
  );
}
