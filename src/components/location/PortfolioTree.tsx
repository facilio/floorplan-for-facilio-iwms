import { useFloorplan } from '../../state/FloorplanContext';
import styles from './PortfolioTree.module.css';

interface FlatNode {
  id: string;
  name: string;
  pad: number;
  kind: 'site' | 'building' | 'floor';
  hasChildren: boolean;
  expanded: boolean;
  active: boolean;
  badge: string | null;
  drillIn: boolean;
  onClick: () => void;
}

export function PortfolioTree() {
  const { state, actions } = useFloorplan();

  const items: FlatNode[] = [];
  for (const site of state.portfolio) {
    const siteExpanded = !!state.expanded[site.id];
    items.push({
      id: site.id,
      name: site.name,
      pad: 8,
      kind: 'site',
      hasChildren: true,
      expanded: siteExpanded,
      active: false,
      badge: null,
      drillIn: false,
      onClick: () => actions.toggleNode(site.id),
    });
    if (!siteExpanded) continue;
    for (const building of site.buildings) {
      const buildingExpanded = !!state.expanded[building.id];
      items.push({
        id: building.id,
        name: building.name,
        pad: 24,
        kind: 'building',
        hasChildren: true,
        expanded: buildingExpanded,
        active: false,
        badge: null,
        drillIn: false,
        onClick: () => actions.toggleNode(building.id),
      });
      if (!buildingExpanded) continue;
      for (const floor of building.floors) {
        // A floor "has a plan" if the static portfolio flag says so OR an actual floorplan is
        // known for it (uploaded this session, or listed from the vibe-db file store at boot) —
        // without the OR, a freshly-uploaded floor kept reading "no plan" in this tree.
        const hasPlan = !!floor.hasPlan || !!state.floorsWithPlans[floor.id];
        items.push({
          id: floor.id,
          name: floor.name,
          pad: 42,
          kind: 'floor',
          hasChildren: false,
          expanded: false,
          active: state.floorId === floor.id,
          // No unit count: only the current floor's units are loaded, so every
          // other floor would read a misleading "0 units". "no plan" stays —
          // it's known from the portfolio flag regardless of what's loaded.
          badge: hasPlan ? null : 'no plan',
          drillIn: hasPlan,
          onClick: () => {
            actions.selectFloor(floor.id);
            actions.setNavView('spaces');
          },
        });
      }
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.label}>Choose a floor</div>
      <div className={styles.list}>
        {items.map((n) => (
          <div key={n.id} className={[styles.row, n.active ? styles.rowActive : ''].join(' ')} style={{ paddingLeft: n.pad }} onClick={n.onClick}>
            {n.hasChildren && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={styles.chevron}
                style={{ transform: `rotate(${n.expanded ? 90 : 0}deg)` }}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
            {n.kind === 'site' && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            )}
            {n.kind === 'building' && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                <rect x="4" y="2" width="16" height="20" rx="1" />
                <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
              </svg>
            )}
            {n.kind === 'floor' && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
              </svg>
            )}
            <span className={styles.name}>{n.name}</span>
            {n.badge && <span className={styles.badge}>{n.badge}</span>}
            {n.drillIn && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
