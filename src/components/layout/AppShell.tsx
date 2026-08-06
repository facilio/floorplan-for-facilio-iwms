import { useEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BottomNav, useAdminSurfacesAllowed } from './BottomNav';
import { MapStage } from './MapStage';
import { SettingsScreen } from '../settings/SettingsScreen';
import { BookingsView } from '../bookings/BookingsView';
import { PeopleView } from '../people/PeopleView';
import { ErrorBoundary } from '../primitives/ErrorBoundary';
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
        {/* A failure in ONE surface is reported and contained; the toast stack lives OUTSIDE
            every boundary so the message can still be shown (requested — an error must surface
            as a toast, not take the app down). */}
        <ErrorBoundary label="this floor" onError={(m) => actions.showToast(`Something went wrong: ${m}`, { variant: 'error' })} resetKey={`${state.floorId}:${state.mobSel ?? ''}`}>
          <MobileApp mode="page" />
        </ErrorBoundary>
        <ErrorBoundary label="the booking form" silent onError={(m) => actions.showToast(`Couldn't show the booking form: ${m}`, { variant: 'error' })} resetKey={state.bookForm?.unitId ?? null}>
          <BookingModal />
        </ErrorBoundary>
        <ErrorBoundary label="the person list" silent onError={(m) => actions.showToast(`Couldn't show the person list: ${m}`, { variant: 'error' })} resetKey={state.peoplePicker}>
          <PeoplePickerModal />
        </ErrorBoundary>
        <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Per-VIEW boundary: a broken record on one screen must not blank the app — the bottom
          nav stays usable, so the user can move somewhere that works. */}
      <ErrorBoundary
        label={`the ${state.activeView} view`}
        onError={(m) => actions.showToast(`Something went wrong: ${m}`, { variant: 'error' })}
        resetKey={`${state.activeView}:${state.floorId}:${state.selected ?? ''}`}
      >
        {state.activeView === 'settings' && adminAllowed ? (
          <SettingsScreen />
        ) : state.activeView === 'bookings' && state.modePerms.book ? (
          <BookingsView />
        ) : state.activeView === 'people' && adminAllowed ? (
          <PeopleView />
        ) : (
          <MapStage stageRef={stageRef} />
        )}
      </ErrorBoundary>
      <BottomNav />
      <ErrorBoundary label="the booking form" silent onError={(m) => actions.showToast(`Couldn't show the booking form: ${m}`, { variant: 'error' })} resetKey={state.bookForm?.unitId ?? null}>
        <BookingModal />
      </ErrorBoundary>
      <ErrorBoundary label="the person list" silent onError={(m) => actions.showToast(`Couldn't show the person list: ${m}`, { variant: 'error' })} resetKey={state.peoplePicker}>
        <PeoplePickerModal />
      </ErrorBoundary>
      <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
    </div>
  );
}
