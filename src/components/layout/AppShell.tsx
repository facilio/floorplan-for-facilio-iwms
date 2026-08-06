import { useEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BottomNav, useAdminSurfacesAllowed } from './BottomNav';
import { MapStage } from './MapStage';
import { SettingsScreen } from '../settings/SettingsScreen';
import { BookingsView } from '../bookings/BookingsView';
import { PeopleView } from '../people/PeopleView';
import { PeoplePickerModal } from '../details/PeoplePickerModal';
import { BookingModal } from '../details/BookingModal';
import { hostIsMobile, hostIsMobileParam } from '../../lib/facilioApi';
import { MobileApp } from '../mobile/MobileApp';
import { ToastStack } from '../primitives/Toast';
import styles from './AppShell.module.css';

export function AppShell() {
  const { state, actions } = useFloorplan();
  const narrowViewport = useMediaQuery('(max-width: 720px)');
  // The HOST can also force the mobile experience via the connected-app `isMobile` param
  // (requested) — checked synchronously from the URL, then confirmed from the SDK properties.
  const [hostMobile, setHostMobile] = useState(hostIsMobileParam());
  useEffect(() => {
    let alive = true;
    void hostIsMobile().then((v) => {
      if (alive && v) setHostMobile(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const isMobileViewport = narrowViewport || hostMobile;
  // Settings + People are maintenance-app surfaces (see useAdminSurfacesAllowed) — gate the
  // ROUTES too, so a deep link / saved URL can't open them from a portal embed.
  const adminAllowed = useAdminSurfacesAllowed();
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
        <PeoplePickerModal />
        <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {state.activeView === 'settings' && adminAllowed ? (
        <SettingsScreen />
      ) : state.activeView === 'bookings' && state.modePerms.book ? (
        <BookingsView />
      ) : state.activeView === 'people' && adminAllowed ? (
        <PeopleView />
      ) : (
        <MapStage stageRef={stageRef} />
      )}
      <BottomNav />
      <BookingModal />
      <PeoplePickerModal />
      <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
    </div>
  );
}
