import { useRef } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BottomNav } from './BottomNav';
import { MapStage } from './MapStage';
import { SettingsScreen } from '../settings/SettingsScreen';
import { BookingsView } from '../bookings/BookingsView';
import { PeopleView } from '../people/PeopleView';
import { BookingModal } from '../details/BookingModal';
import { MobileApp } from '../mobile/MobileApp';
import { Toast } from '../primitives/Toast';
import styles from './AppShell.module.css';

export function AppShell() {
  const { state } = useFloorplan();
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
        <Toast message={state.toast} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {state.activeView === 'settings' ? (
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
      <Toast message={state.toast} />
    </div>
  );
}
