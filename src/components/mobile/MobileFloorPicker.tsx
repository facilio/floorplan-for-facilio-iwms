import { useFloorplan } from '../../state/FloorplanContext';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileFloorPicker.module.css';

type LevelKind = 'site' | 'building' | 'floor';

/** Same glyphs as the web PortfolioTree, so the hierarchy reads identically. */
function LevelIcon({ kind }: { kind: LevelKind }) {
  return (
    <span className={styles.levelIcon}>
      {kind === 'site' && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      )}
      {kind === 'building' && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="2" width="16" height="20" rx="1" />
          <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
        </svg>
      )}
      {kind === 'floor' && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
        </svg>
      )}
    </span>
  );
}

export function MobileFloorPicker() {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(() => actions.setMobFloorOpen(false), state.mobFloorOpen);
  if (!state.mobFloorOpen) return null;

  const site = state.portfolio.find((s) => s.id === state.mobPickSite);
  const building = site?.buildings.find((b) => b.id === state.mobPickBuilding);

  let title = 'Choose a site';
  let rows: { id: string; name: string; sub: string; kind: LevelKind; active?: boolean; showChevron?: boolean; onTap: () => void }[] = [];

  if (!site) {
    title = 'Choose a site';
    rows = state.portfolio.map((s) => ({
      id: s.id,
      name: s.name,
      sub: `${s.buildings.length} building${s.buildings.length === 1 ? '' : 's'}`,
      kind: 'site' as const,
      showChevron: true,
      onTap: () => actions.setMobPick(s.id, null),
    }));
  } else if (!building) {
    title = site.name;
    rows = site.buildings.map((b) => ({
      id: b.id,
      name: b.name,
      sub: `${b.floors.length} floor${b.floors.length === 1 ? '' : 's'}`,
      kind: 'building' as const,
      showChevron: true,
      onTap: () => actions.setMobPick(site.id, b.id),
    }));
  } else {
    title = building.name;
    rows = building.floors.map((f) => ({
      id: f.id,
      name: f.name,
      sub: f.hasPlan ? '' : 'No plan',
      kind: 'floor' as const,
      active: state.floorId === f.id,
      onTap: () => {
        actions.selectFloor(f.id);
        actions.setMobFloorOpen(false);
      },
    }));
  }

  const canBack = !!site;
  function onBack() {
    if (building) actions.setMobPick(site!.id, null);
    else actions.setMobPick(null, null);
  }

  return (
    <>
      <div className={styles.backdrop} onClick={() => actions.setMobFloorOpen(false)} />
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          {canBack && (
            <button className={styles.back} onClick={onBack} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <span className={styles.title}>{title}</span>
        </div>
        <div className={styles.list}>
          {rows.map((r) => (
            <div key={r.id} className={styles.row} onClick={r.onTap}>
              <LevelIcon kind={r.kind} />
              <div className={styles.rowText}>
                <div className={[styles.rowName, r.active ? styles.rowNameActive : ''].join(' ')}>{r.name}</div>
                {r.sub && <div className={styles.rowSub}>{r.sub}</div>}
              </div>
              {r.active && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue-600)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
              {r.showChevron && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
