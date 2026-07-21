import { useFloorplan } from '../../state/FloorplanContext';
import { unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { TYPE_META } from '../../lib/types';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileMyBookings.module.css';

/**
 * "My bookings" sheet (mobile calendar icon). Lists the signed-in user's
 * bookings for the selected floor + date from state.bookings — tap a row to
 * locate the space on the plan, or cancel it.
 */
export function MobileMyBookings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(onClose, open);
  if (!open) return null;

  const mine = state.bookings
    .filter((b) => b.by === state.bookBy)
    .sort((a, b) => a.start - b.start);
  const dateLabel = new Date(state.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          <div>
            <div className={styles.title}>My bookings</div>
            <div className={styles.sub}>{dateLabel}</div>
          </div>
          <span className={styles.count}>{mine.length}</span>
        </div>

        {mine.length === 0 ? (
          <div className={styles.empty}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ink-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <div className={styles.emptyText}>No bookings on this date.</div>
            <div className={styles.emptySub}>Switch to the Book tab and drag a time on a space to reserve it.</div>
          </div>
        ) : (
          <div className={styles.list}>
            {mine.map((b) => {
              const unit = unitById(state, b.unitId);
              return (
                <div key={b.id} className={styles.row}>
                  <button
                    className={styles.rowMain}
                    onClick={() => {
                      onClose();
                      actions.setMobSel(b.unitId);
                    }}
                  >
                    <span className={styles.time}>
                      {fmtTime(b.start)}
                      <span className={styles.timeEnd}>{fmtTime(b.end)}</span>
                    </span>
                    <span className={styles.rowText}>
                      <span className={styles.rowLabel}>{unit?.label ?? 'Space'}</span>
                      <span className={styles.rowSub}>
                        {unit ? TYPE_META[unit.type].name : 'Booking'}
                        {b.purpose ? ` · ${b.purpose}` : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    className={styles.cancelBtn}
                    onClick={() => {
                      if (confirm('Cancel this booking?')) actions.cancelBooking(b.id);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
