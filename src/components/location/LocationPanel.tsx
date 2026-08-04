import { useFloorplan } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { usePanelDrag } from '../../hooks/usePanelDrag';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { ALL_PLAN_TYPES } from '../../lib/types';
import type { PlanId } from '../../lib/types';
import { FloatingPanel } from '../primitives/FloatingPanel';
import { Select } from '../primitives/Select';
import { PortfolioTree } from './PortfolioTree';
import { SpacesList } from './SpacesList';
import styles from './LocationPanel.module.css';

const PANEL_WIDTH = 288;

const LocationIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

export function LocationPanel() {
  const { state, actions } = useFloorplan();
  const drag = usePanelDrag('portfolio', PANEL_WIDTH);
  const meta = floorMeta(state, state.floorId);
  const floor = meta?.floor;
  const isTree = state.navView === 'tree';
  // MAINTENANCE offers all three plan types — picking an unconfigured one shows the empty
  // state with its upload button, which is where plans get set up. PORTALS show only the
  // types that actually have a plan (requested): the per-floor fetch is authoritative once
  // in, the org scan covers floors not visited yet, and while neither is loaded nothing is
  // filtered (fail-open). The mock tier keeps its old behavior (demo floors define `plans`).
  const configured = state.floorPlanTypes[state.floorId];
  const portalConfigured = (p: { id: PlanId }) => {
    if (configured) return configured.some((t) => t.id === p.id);
    const scoped = state.portalPlanFloors?.floors[state.floorId];
    // [] = the floor HAS a plan but the types aren't known yet (floor-filter path) — don't
    // filter until the per-floor fetch lands.
    return !scoped || scoped.length === 0 || scoped.includes(p.id);
  };
  const plans = !isFacilioApiConfigured ? floor?.plans : state.isPortalApp ? ALL_PLAN_TYPES.filter(portalConfigured) : ALL_PLAN_TYPES;

  return (
    <FloatingPanel
      x={drag.x}
      y={drag.y}
      open={drag.open}
      width={PANEL_WIDTH}
      maxHeight={drag.maxH}
      title="Location"
      icon={LocationIcon}
      translucent
      zIndex={42}
      onHeaderDown={drag.onHeaderDown}
      onToggle={drag.onToggle}
      onIconDown={drag.onIconDown}
      onIconClick={drag.onIconClick}
    >
      <div className={styles.body}>
        <div className={styles.switcherRow}>
          <button className={styles.switcher} onClick={() => actions.setNavView(isTree ? 'spaces' : 'tree')}>
            <span className={styles.switcherIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
              </svg>
            </span>
            <span className={styles.switcherText}>
              {/* Both lines ellipsize — the title carries the full path for long names. */}
              <span className={styles.switcherPath} title={meta ? `${meta.site.name} › ${meta.building.name}` : undefined}>
                {meta ? `${meta.site.name} › ${meta.building.name}` : ''}
              </span>
              <span className={styles.switcherName} title={floor?.name}>{floor?.name ?? 'Choose a floor'}</span>
            </span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink-500)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, transform: `rotate(${isTree ? 180 : 0}deg)`, transition: 'transform 160ms var(--ease-standard)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {!isTree && plans && plans.length > 1 && (
            <Select
              value={state.planId}
              options={plans.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(v) => actions.setPlan(v)}
              size="sm"
              fullWidth
              aria-label="Plan"
            />
          )}
        </div>
        {isTree ? <PortfolioTree /> : <SpacesList />}
      </div>
    </FloatingPanel>
  );
}
