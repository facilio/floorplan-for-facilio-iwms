import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
  fullWidth?: boolean;
}

export function Button({ variant = 'secondary', icon, fullWidth, className, children, ...rest }: ButtonProps) {
  const cls = [styles.btn, styles[variant], fullWidth ? styles.fullWidth : '', className].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}
