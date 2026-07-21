import styles from './StatusPill.module.css';

interface StatusPillProps {
  label: string;
  bg: string;
  fg: string;
}

export function StatusPill({ label, bg, fg }: StatusPillProps) {
  return (
    <span className={styles.pill} style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
