import { useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { initials } from '../../state/selectors';
import { facilioRecordUrl } from '../../lib/facilioApi';
import styles from './PeopleView.module.css';

/** Simple directory of employees. Assigned desks are derived from `state.assignments`. */
export function PeopleView() {
  const { state } = useFloorplan();
  const [search, setSearch] = useState('');

  const deskByEmp = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [unitId, empId] of Object.entries(state.assignments)) {
      const u = state.units.find((x) => x.id === unitId);
      if (u) map[empId] = u.label;
    }
    return map;
  }, [state.assignments, state.units]);

  const people = state.employees
    .filter((e) => !search || e.name.toLowerCase().includes(search.toLowerCase()) || (e.dept ?? '').toLowerCase().includes(search.toLowerCase()))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.h1}>People</h1>
            <p className={styles.sub}>{state.employees.length} people in this workspace</p>
          </div>
          <input className={styles.search} placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {people.length === 0 ? (
          <div className={styles.empty}>No people match “{search}”.</div>
        ) : (
          <div className={styles.list}>
            {people.map((e) => {
              const real = /^\d+$/.test(e.id) ? facilioRecordUrl('employee', e.id) : null;
              const desk = deskByEmp[e.id];
              return (
                <div key={e.id} className={styles.row}>
                  <span className={styles.avatar}>{initials(e.name) || '·'}</span>
                  <div className={styles.meta}>
                    <span className={styles.name}>{e.name}</span>
                    {e.dept && <span className={styles.dept}>{e.dept}</span>}
                  </div>
                  {desk && <span className={styles.deskPill}>{desk}</span>}
                  {real && (
                    <a className={styles.openLink} href={real} target="_blank" rel="noreferrer" title="Open record in Facilio">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <path d="M15 3h6v6M10 14L21 3" />
                      </svg>
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
