import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { Canvas } from '../canvas/Canvas';
import { EmptyPlanState } from '../canvas/EmptyPlanState';
import { FloorplanSkeleton } from '../canvas/FloorplanSkeleton';
import { FloorUploadModal } from '../canvas/FloorUploadModal';
import { AutoMapModal } from '../canvas/AutoMapModal';
import { MapDeskModal } from '../canvas/MapDeskModal';
import { UnsavedChangesModal } from '../canvas/UnsavedChangesModal';
import { LocationPanel } from '../location/LocationPanel';
import { DetailsPanel } from '../details/DetailsPanel';
import { Toolbar } from './Toolbar';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { floorImageKey } from '../../lib/types';
import styles from './MapStage.module.css';

export function MapStage({ stageRef }: { stageRef: RefObject<HTMLDivElement> }) {
  const { state, actions } = useFloorplan();

  // Keep state.stage in sync from the stage wrapper itself. The Canvas has its
  // own observer, but it's unmounted while the loading skeleton (or the empty
  // state) shows — the floating panels would then position/clamp against the
  // stale default 1200×700 stage and land mid-screen over the toolbar.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 20) actions.setStageSize(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const floor = floorMeta(state, state.floorId)?.floor;
  const isDevMode = import.meta.env.VITE_DEV_MODE === 'true';
  const hasImage = !!state.floorImages[floorImageKey(state.floorId, state.planId)];
  // Units alone only justify showing the canvas in dev mode, where the mock tier draws a
  // schematic background under them. Deployed, a plan without an actual image would render
  // markers on a blank white sheet — the "empty floorplan" — so there only a real image (or a
  // real-backend plan-type record, below) counts, and the empty state's upload prompt shows
  // instead once the shimmer clears.
  const hasContent = hasImage || (isDevMode && state.units.length > 0);
  // Against the real backend, `state.floorPlanTypes[floorId]` (fetched per-floor on selection)
  // says exactly which plan types have a floor plan configured — once it's in, trust it over
  // the coarse `floor.hasPlan` flag, which describes the floor as a whole rather than the
  // currently-selected plan type. Before it's loaded (undefined) or on the mock tier (never
  // set), fall back to the old floor-level flag — dev only, so a deployed floor never fakes it.
  const configuredTypes = state.floorPlanTypes[state.floorId];
  const typeConfigured = configuredTypes ? configuredTypes.some((t) => t.id === state.planId) : isDevMode && !!floor?.hasPlan;
  const hasPlan = hasContent || typeConfigured;
  // While the real image fetch/render for this floor/plan is in flight, the shimmer skeleton
  // takes over the whole stage — the canvas (and its markers) only appears once the actual plan
  // image is there, never over a placeholder that reads as real-but-wrong data.
  const showSkeleton = state.floorImageLoading;

  const leftPad = state.panels.portfolio.open ? 320 : 76;
  const rightPad = state.panels.details.open ? 336 : 76;

  const layoutMoved = (['portfolio', 'details'] as const).some((id) => state.panels[id].x != null || !state.panels[id].open);

  return (
    <div ref={stageRef} className={styles.stage}>
      <LocationPanel />

      <Toolbar leftPad={leftPad} rightPad={rightPad} />

      {showSkeleton ? <FloorplanSkeleton /> : !hasPlan ? <EmptyPlanState /> : <Canvas />}

      <div className={styles.topBar}>
        {state.mode === 'edit' && state.unsavedChanges > 0 && (
          <div className={styles.unsavedBar}>
            <span>{state.unsavedChanges} unsaved change{state.unsavedChanges === 1 ? '' : 's'}</span>
            {/* Discard-in-place: revert to the last save and stay in edit mode. */}
            <button className={styles.unsavedDiscard} onClick={actions.discardChanges}>
              Discard
            </button>
            <button className={styles.unsavedSave} disabled={state.saving} onClick={actions.saveChanges}>
              {state.saving && <ButtonSpinner />}
              {state.saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      <DetailsPanel />

      {layoutMoved && (
        <div className={styles.resetLayout}>
          <Button variant="secondary" onClick={actions.resetLayout}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Reset layout
          </Button>
        </div>
      )}

      <FloorUploadModal />
      <AutoMapModal />
      <MapDeskModal />
      <UnsavedChangesModal />
    </div>
  );
}
