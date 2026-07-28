import { useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { searchPortfolio } from '../../lib/facilioApiDataSource';
import type { PortfolioSearchResults } from '../../lib/facilioApiDataSource';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [apiResults, setApiResults] = useState<PortfolioSearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const useApiSearch = isFacilioApiConfigured && q.length > 0;

  // Server-side search (debounced): the text goes to the API for sites, buildings AND floors —
  // results aren't limited to branches already lazy-loaded into the tree.
  useEffect(() => {
    if (!useApiSearch) {
      setApiResults(null);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      searchPortfolio(query)
        .then((r) => {
          if (!cancelled) setApiResults(r);
        })
        .catch(() => {
          if (!cancelled) setApiResults({ sites: [], buildings: [], floors: [] });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, useApiSearch]);

  /** Expand a node (loading its children lazily) without collapsing it when already open. */
  const expand = (id: string) => {
    if (!state.expanded[id]) actions.toggleNode(id);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
  };

  const items: FlatNode[] = [];
  for (const site of state.portfolio) {
    // Searching: a node shows when IT matches or any LOADED descendant does, and matched
    // branches render expanded so the hit is visible without extra clicks. (Children are
    // lazy-loaded — un-expanded sites/buildings can only be searched by their own names.)
    const siteMatch = matches(site.name);
    const buildingHits = q ? site.buildings.filter((b) => matches(b.name) || b.floors.some((f) => matches(f.name))) : site.buildings;
    if (q && !siteMatch && buildingHits.length === 0) continue;
    const siteExpanded = q ? buildingHits.length > 0 || site.buildings.length > 0 : !!state.expanded[site.id];
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
    for (const building of q && !siteMatch ? buildingHits : site.buildings) {
      const buildingMatch = matches(building.name);
      const floorHits = q ? building.floors.filter((f) => matches(f.name)) : building.floors;
      if (q && !siteMatch && !buildingMatch && floorHits.length === 0) continue;
      const buildingExpanded = q ? floorHits.length > 0 : !!state.expanded[building.id];
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
      for (const floor of q && !siteMatch && !buildingMatch ? floorHits : building.floors) {
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
      <div className={styles.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>Choose a floor</span>
        {/* Search toggles open from the icon; closing clears the filter. */}
        <button
          type="button"
          title={searchOpen ? 'Close search' : 'Search sites & buildings'}
          aria-label={searchOpen ? 'Close search' : 'Search sites and buildings'}
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
          placeholder="Search sites, buildings, floors…"
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
      {/* API-backed search: the text queries sites, buildings AND floors server-side and drives
          the switcher from the results — not limited to lazily-loaded branches. */}
      {useApiSearch && (
        <div className={styles.list}>
          {searching && <div style={{ padding: '8px 12px', font: '400 12px var(--font-sans)', color: 'var(--ink-500)' }}>Searching…</div>}
          {!searching && apiResults && apiResults.sites.length + apiResults.buildings.length + apiResults.floors.length === 0 && (
            <div style={{ padding: '8px 12px', font: '400 12px var(--font-sans)', color: 'var(--ink-500)' }}>Nothing matches “{query.trim()}”.</div>
          )}
          {!searching && !!apiResults?.sites.length && (
            <div style={{ padding: '6px 12px 2px', font: '600 10.5px var(--font-sans)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-400)' }}>Sites</div>
          )}
          {!searching &&
            apiResults?.sites.map((s) => (
              <div key={`s${s.id}`} className={styles.row} style={{ paddingLeft: 8 }} onClick={() => { expand(s.id); closeSearch(); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" /><circle cx="12" cy="10" r="3" />
                </svg>
                <span className={styles.name} title={s.name}>{s.name}</span>
              </div>
            ))}
          {!searching && !!apiResults?.buildings.length && (
            <div style={{ padding: '6px 12px 2px', font: '600 10.5px var(--font-sans)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-400)' }}>Buildings</div>
          )}
          {!searching &&
            apiResults?.buildings.map((b) => (
              <div
                key={`b${b.id}`}
                className={styles.row}
                style={{ paddingLeft: 8 }}
                onClick={() => {
                  if (b.siteId) expand(b.siteId);
                  expand(b.id);
                  closeSearch();
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <rect x="4" y="2" width="16" height="20" rx="1" />
                </svg>
                <span className={styles.name} title={b.name}>{b.name}</span>
                {b.siteName && <span className={styles.badge} title={b.siteName}>{b.siteName}</span>}
              </div>
            ))}
          {!searching && !!apiResults?.floors.length && (
            <div style={{ padding: '6px 12px 2px', font: '600 10.5px var(--font-sans)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-400)' }}>Floors</div>
          )}
          {!searching &&
            apiResults?.floors.map((f) => (
              <div
                key={`f${f.id}`}
                className={styles.row}
                style={{ paddingLeft: 8 }}
                onClick={() => {
                  if (f.siteId) expand(f.siteId);
                  if (f.buildingId) expand(f.buildingId);
                  actions.selectFloor(f.id);
                  actions.setNavView('spaces');
                  closeSearch();
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.typeIcon}>
                  <path d="M12 2L2 7l10 5 10-5-10-5z M2 12l10 5 10-5 M2 17l10 5 10-5" />
                </svg>
                <span className={styles.name} title={f.path ? `${f.path} › ${f.name}` : f.name}>{f.name}</span>
                {f.path && <span className={styles.badge} title={f.path}>{f.path}</span>}
              </div>
            ))}
        </div>
      )}
      {!useApiSearch && q && items.length === 0 && (
        <div style={{ padding: '10px 12px', font: '400 12px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>
          Nothing matches “{query.trim()}”. Un-loaded buildings/floors are searched by name only after their site is expanded once.
        </div>
      )}
      {useApiSearch ? null : (
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
            {/* Long site/building/floor names ellipsize — the title shows them in full on hover. */}
            <span className={styles.name} title={n.name}>{n.name}</span>
            {n.badge && <span className={styles.badge}>{n.badge}</span>}
            {n.drillIn && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
