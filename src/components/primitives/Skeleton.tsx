import styles from './Skeleton.module.css';

/**
 * Generic shimmer rows for side-panel lists while their data loads: an
 * optional avatar circle, two text lines of varying width, and a trailing
 * pill — each with a sweeping highlight, staggered per row.
 */
export function SkeletonRows({ rows = 6, avatar = false }: { rows?: number; avatar?: boolean }) {
  return (
    <div className={styles.wrap} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row} style={{ ['--delay' as string]: `${(i * 0.09).toFixed(2)}s` }}>
          {avatar ? <span className={styles.avatar} /> : <span className={styles.dot} />}
          <span className={styles.lines}>
            <span className={styles.line} style={{ width: `${58 - (i % 3) * 9}%` }} />
            <span className={[styles.line, styles.lineSub].join(' ')} style={{ width: `${38 - (i % 2) * 8}%` }} />
          </span>
          <span className={styles.pill} />
        </div>
      ))}
    </div>
  );
}
