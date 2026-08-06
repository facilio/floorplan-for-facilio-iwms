import { useEffect, useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { orgNow } from '../../lib/orgTime';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchCurrentApp, fetchOrgBookableResources, fetchOrgBookingsForRange } from '../../lib/facilioApiDataSource';
import { TYPE_META } from '../../lib/types';
import type { Booking, Unit } from '../../lib/types';
import { StateflowActions } from '../details/StateflowActions';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileMyBookings.module.css';

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * "My bookings" sheet (mobile calendar icon) — the SAME contract as the web popup: ORG-WIDE
 * bookings of the signed-in client contact for the week ahead (one range request, scoped
 * SERVER-SIDE by reservedBy in portals), each row managed by the record's OWN stateflow buttons
 * rather than a hardcoded Cancel. Tap a row to locate the space on the plan.
 */
export function MobileMyBookings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(onClose, open);
  const [isPortal, setIsPortal] = useState(false);
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [orgUnits, setOrgUnits] = useState<Unit[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let alive = true;
    if (isFacilioApiConfigured) {
      fetchCurrentApp().then((a) => alive && setIsPortal(!!a?.linkName && a.linkName !== 'maintenance')).catch(() => {});
      fetchOrgBookableResources().then((u) => alive && setOrgUnits(u)).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  // Same range fetch the web calendar uses: today .. +7 days on the ORG clock, one request.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    if (!isFacilioApiConfigured) {
      setRows(null);
      return;
    }
    const today = orgNow().dateISO;
    fetchOrgBookingsForRange(today, addDaysIso(today, 7), isPortal ? { forCurrentUser: true } : undefined)
      .then((list) => alive && setRows(list))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [open, isPortal, state.bookingsNonce, refreshTick]);

  const mine = useMemo(() => {
    // PORTALS: already scoped server-side to this client contact, so every row is theirs (matching
    // on reservedBy again dropped rows whose lookup the projection omitted — same fix as the web).
    const source = rows ?? state.bookings;
    const list = rows ? (isPortal ? source : source.filter((b) => b.by === state.bookBy)) : source.filter((b) => b.by === state.bookBy);
    return [...list].sort((a, b) => (a.date === b.date ? a.start - b.start : a.date.localeCompare(b.date)));
  }, [rows, state.bookings, state.bookBy, isPortal]);

  if (!open) return null;

  const dateLabel = rows ? 'Next 7 days' : new Date(state.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

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
              // Org-wide rows can name a space that isn't on the current floor — same pool
              // fallback the web popup uses.
              const unit = unitById(state, b.unitId) ?? orgUnits.find((u) => u.id === b.unitId);
              const isReal = /^\d+$/.test(b.id);
              return (
                <div key={b.id} className={styles.row} style={{ flexWrap: 'wrap' }}>
                  <button
                    className={styles.rowMain}
                    onClick={() => {
                      onClose();
                      actions.setMobSel(b.unitId);
                    }}
                  >
                    {/* ONE range on ONE line, org clock — the stacked start/end read as two
                        separate times (reported). */}
                    <span className={styles.time}>
                      {fmtTime(b.start)} – {fmtTime(b.end)}
                    </span>
                    <span className={styles.rowText}>
                      <span className={styles.rowLabel} data-tip={unit?.label ?? b.name ?? 'Space'}>{unit?.label ?? b.name ?? 'Space'}</span>
                      <span className={styles.rowSub}>
                        {new Date(`${b.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                        {unit ? ` · ${TYPE_META[unit.type].name}` : ''}
                        {b.purpose ? ` · ${b.purpose}` : ''}
                      </span>
                    </span>
                  </button>
                  {/* ACTIONS COME FROM THE API (same as the web): the record's own stateflow /
                      approval transitions — no hardcoded Cancel. Local-only rows (non-numeric
                      ids, prototype tier) keep the direct cancel since they have no record. */}
                  {isReal ? (
                    <div style={{ flexBasis: '100%' }}>
                      <StateflowActions
                        moduleName="spacebooking"
                        recordId={Number(b.id)}
                        onChanged={() => {
                          setRefreshTick((t) => t + 1);
                          actions.refreshBookings();
                        }}
                      />
                    </div>
                  ) : (
                    <button className={styles.cancelBtn} onClick={() => actions.cancelBooking(b.id)}>
                      Cancel
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
