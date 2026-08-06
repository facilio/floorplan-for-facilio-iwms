import { useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { searchBranchChildren, searchSiteIds } from '../../lib/facilioApiDataSource';
import styles from './PortfolioTree.module.css';

interface FlatNode {
  row: 'node';
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

/** In-branch search input row — buildings within one site, floors within one building. */
interface SearchRow {
  row: 'search';
  parentId: string;
  parentKind: 'site' | 'building';
  pad: number;
}

type Row = FlatNode | SearchRow;

const DEBOUNCE_MS = 300;

export function PortfolioTree() {
  const { state, actions } = useFloorplan();

  // Top search — SITES ONLY (buildings/floors search inside their own branch below). API-backed
  // when configured (ids filter the loaded portfolio), plain name filter in local mode.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [siteIds, setSiteIds] = useState<Set<string> | null>(null);
  const q = query.trim().toLowerCase();

  // One in-branch search at a time: typing under a site searches ITS buildings (API filter
  // site=<id> + search text); under a building, ITS floors. Matching child ids filter the
  // branch's loaded children.
  const [branch, setBranch] = useState<{ id: string; kind: 'site' | 'building'; text: string } | null>(null);
  const [branchIds, setBranchIds] = useState<Set<string> | null>(null);
  const bq = branch?.text.trim().toLowerCase() ?? '';

  // Debounced top (site) search.
  useEffect(() => {
    if (!isFacilioApiConfigured || !q) {
      setSiteIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchSiteIds(query).then((ids) => {
        if (!cancelled) setSiteIds(ids);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Debounced in-branch search.
  useEffect(() => {
    if (!isFacilioApiConfigured || !branch || !bq) {
      setBranchIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchBranchChildren(branch.kind, branch.id, branch.text).then((ids) => {
        if (!cancelled) setBranchIds(ids);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch?.id, branch?.kind, bq]);

  /** Does this branch's child pass its in-branch filter? API ids when loaded, name filter meanwhile/locally. */
  const branchPass = (parentId: string, childId: string, childName: string): boolean => {
    if (!branch || branch.id !== parentId || !bq) return true;
    if (isFacilioApiConfigured && branchIds) return branchIds.has(childId);
    return childName.toLowerCase().includes(bq);
  };

  // PORTALS show only sites/buildings/floors with an indoorfloorplan (scope from one filtered
  // floor query; null = no filtering). A level whose set came back EMPTY (projection omitted
  // the lookup) is not gated — fail open per level, never hide everything by accident.
  const scope = state.portalPlanFloors;
  const siteAllowed = (id: string) => !scope || Object.keys(scope.sites).length === 0 || !!scope.sites[id];
  const buildingAllowed = (id: string) => !scope || Object.keys(scope.buildings).length === 0 || !!scope.buildings[id];
  const floorAllowed = (id: string) => !scope || !!scope.floors[id] || !!state.floorsWithPlans[id];

  const items: Row[] = [];
  for (const site of state.portfolio) {
    if (!siteAllowed(site.id)) continue;
    // Top search: sites only — API ids when configured, name filter otherwise.
    if (q && (isFacilioApiConfigured && siteIds ? !siteIds.has(site.id) : !site.name.toLowerCase().includes(q))) continue;
    const siteExpanded = !!state.expanded[site.id];
    items.push({
      row: 'node',
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
    // In-branch building search, scoped to THIS site — collapsed behind the row's search icon.
    if (branch?.id === site.id) items.push({ row: 'search', parentId: site.id, parentKind: 'site', pad: 24 });
    for (const building of site.buildings) {
      if (!buildingAllowed(building.id)) continue;
      if (!branchPass(site.id, building.id, building.name)) continue;
      const buildingExpanded = !!state.expanded[building.id];
      items.push({
        row: 'node',
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
      // In-branch floor search, scoped to THIS building — collapsed behind the row's search icon.
      if (branch?.id === building.id) items.push({ row: 'search', parentId: building.id, parentKind: 'building', pad: 42 });
      for (const floor of building.floors) {
        if (!branchPass(building.id, floor.id, floor.name)) continue;
        if (!floorAllowed(floor.id)) continue;
        // A floor "has a plan" if the static portfolio flag says so OR an actual floorplan is
        // known for it (uploaded this session, or listed from the vibe-db file store at boot) —
        // without the OR, a freshly-uploaded floor kept reading "no plan" in this tree.
        const hasPlan = !!floor.hasPlan || !!state.floorsWithPlans[floor.id];
        items.push({
          row: 'node',
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

  const visibleNodes = items.filter((r): r is FlatNode => r.row === 'node');

  return (
    <div className={styles.wrap}>
      <div className={styles.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>Choose a floor</span>
        {/* Top search toggles open from the icon; closing clears it. Sites only. */}
        <button
          type="button"
          title={searchOpen ? 'Close search' : 'Search sites'}
          aria-label={searchOpen ? 'Close search' : 'Search sites'}
          onClick={() => {
            setSearchOpen((o) => !o);
            setQuery('');
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 'none', background: 'none', color: 'var(--ink-500)', cursor: 'pointer', borderRadius: 5 }}
        >
          {searchOpen ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          )}
        </button>
      </div>
      {searchOpen && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sites…"
          style={{
            margin: '0 8px 8px',
            padding: '7px 10px',
            border: '1px solid var(--ink-200)',
            borderRadius: 7,
            font: '400 12.5px var(--font-sans)',
            color: 'var(--ink-900)',
            outline: 'none',
            width: 'calc(100% - 16px)',
            boxSizing: 'border-box',
          }}
        />
      )}
      {q && visibleNodes.length === 0 && (
        <div style={{ padding: '10px 12px', font: '400 12px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>
          No sites match “{query.trim()}”.
        </div>
      )}
      <div className={styles.list}>
        {items.map((r) =>
          r.row === 'search' ? (
            <div key={`search-${r.parentId}`} style={{ padding: '2px 8px 4px', paddingLeft: r.pad }}>
              <input
                autoFocus
                value={branch?.id === r.parentId ? branch.text : ''}
                onChange={(e) => setBranch({ id: r.parentId, kind: r.parentKind, text: e.target.value })}
                placeholder={r.parentKind === 'site' ? 'Search buildings…' : 'Search floors…'}
                aria-label={r.parentKind === 'site' ? 'Search buildings in this site' : 'Search floors in this building'}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '5px 8px',
                  border: '1px solid var(--ink-100)',
                  borderRadius: 6,
                  font: '400 12px var(--font-sans)',
                  color: 'var(--ink-900)',
                  outline: 'none',
                  background: 'var(--ink-025, #f8fafc)',
                }}
              />
            </div>
          ) : (
            <div
              key={r.id}
              className={[styles.row, r.active ? styles.rowActive : ''].join(' ')}
              // Row-anchored: the name ellipsizes, and a clipping box would cut its own tooltip.
              data-tip={r.name}
              style={{ paddingLeft: r.pad }}
              onClick={r.onClick}
            >
              {r.hasChildren && (
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
                  style={{ transform: `rotate(${r.expanded ? 90 : 0}deg)` }}
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
              {r.kind === 'site' && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              )}
              {r.kind === 'building' && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <rect x="4" y="2" width="16" height="20" rx="1" />
                  <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
                </svg>
              )}
              {r.kind === 'floor' && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
                </svg>
              )}
              {/* Long names ellipsize — the row's tooltip shows them in full on hover. */}
              <span className={styles.name}>{r.name}</span>
              {/* Collapsible in-branch search: the icon on an EXPANDED site/building toggles its
                  scoped search bar (buildings within this site / floors within this building). */}
              {r.hasChildren && r.expanded && (
                <button
                  type="button"
                  data-tip={branch?.id === r.id ? 'Close search' : r.kind === 'site' ? 'Search buildings in this site' : 'Search floors in this building'}
                  data-tip-align="end"
                  aria-label={branch?.id === r.id ? 'Close search' : r.kind === 'site' ? 'Search buildings in this site' : 'Search floors in this building'}
                  aria-expanded={branch?.id === r.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBranch(branch?.id === r.id ? null : { id: r.id, kind: r.kind === 'site' ? 'site' : 'building', text: '' });
                  }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flex: 'none', border: 'none', background: branch?.id === r.id ? 'var(--blue-025)' : 'none', color: branch?.id === r.id ? 'var(--blue-600)' : 'var(--ink-400)', cursor: 'pointer', borderRadius: 5 }}
                >
                  {branch?.id === r.id ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                  )}
                </button>
              )}
              {r.badge && <span className={styles.badge}>{r.badge}</span>}
              {r.drillIn && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
