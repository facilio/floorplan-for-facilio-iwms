import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import styles from './BottomNav.module.css';

/** App-level navigation, moved out of the (removed) left sidebar into a floating bottom bar. */
export function BottomNav() {
  const { state, actions } = useFloorplan();
  const view = state.activeView;

  return (
    <nav className={styles.bar} aria-label="Primary">
      <NavBtn
        active={view === 'map'}
        label="Floorplans"
        onClick={actions.openMap}
        icon={<path d="M9 3L4 5v16l5-2 6 2 5-2V3l-5 2-6-2z M9 3v16M15 5v16" />}
      />
      <NavBtn
        active={view === 'bookings'}
        label="Bookings"
        badge={state.bookings.length}
        onClick={actions.openBookings}
        icon={<><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>}
      />
      <NavBtn
        active={view === 'people'}
        label="People"
        onClick={actions.openPeople}
        icon={<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>}
      />
      <NavBtn
        active={view === 'settings'}
        label="Settings"
        onClick={actions.openSettings}
        icon={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>}
      />
    </nav>
  );
}

function NavBtn({ active, label, icon, badge, onClick }: { active: boolean; label: string; icon: ReactNode; badge?: number; onClick: () => void }) {
  return (
    <button className={[styles.btn, active ? styles.btnActive : ''].join(' ')} onClick={onClick} title={label} aria-current={active ? 'page' : undefined}>
      <span className={styles.iconWrap}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
        {badge != null && badge > 0 && <span className={styles.badge}>{badge}</span>}
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
