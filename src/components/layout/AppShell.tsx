import { useRef } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BottomNav, settingsAllowed } from './BottomNav';
import { MapStage } from './MapStage';
import { SettingsScreen } from '../settings/SettingsScreen';
import { BookingsView } from '../bookings/BookingsView';
import { PeopleView } from '../people/PeopleView';
import { BookingModal } from '../details/BookingModal';
import { MobileApp } from '../mobile/MobileApp';
import { ToastStack } from '../primitives/Toast';
import styles from './AppShell.module.css';

export function AppShell() {
  const { state, actions } = useFloorplan();
  const isMobileViewport = useMediaQuery('(max-width: 720px)');
  const stageRef = useRef<HTMLDivElement>(null);

  if (state.loading && state.portfolio.length === 0) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
      </div>
    );
  }

  if (isMobileViewport) {
    return (
      <div className={styles.mobileRoot}>
        <MobileApp mode="page" />
        <BookingModal />
        <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Settings is maintenance-app-only (see BottomNav.showSettingsTab) — gate the ROUTE too,
          so a deep link / saved URL can't open admin setup from a portal embed. */}
      {state.activeView === 'settings' && settingsAllowed ? (
        <SettingsScreen />
      ) : state.activeView === 'bookings' ? (
        <BookingsView />
      ) : state.activeView === 'people' ? (
        <PeopleView />
      ) : (
        <MapStage stageRef={stageRef} />
      )}
      <BottomNav />
      <BookingModal />
      <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
    </div>
  );
}
