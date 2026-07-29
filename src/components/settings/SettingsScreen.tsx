import { useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { STATE_DEFS, STATE_SWATCHES } from '../../lib/types';
import type { ModePerms, UnitType } from '../../lib/types';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchOrgRoles, fetchRolePermissionRecords, updateRolePermissionRecord, updateRolePermissionRoles } from '../../lib/facilioApiDataSource';
import type { OrgRole, RolePermRecord } from '../../lib/facilioApiDataSource';
import { Button } from '../primitives/Button';
import { moduleColor } from '../../lib/unitStatus';
import styles from './SettingsScreen.module.css';

const MODULE_TABS: { id: 'permissions' | 'bookings' | UnitType; name: string }[] = [
  { id: 'permissions', name: 'Roles & access' },
  { id: 'bookings', name: 'Bookings' },
  { id: 'workstation', name: 'Desks' },
  { id: 'locker', name: 'Lockers' },
  { id: 'parking', name: 'Parking' },
  { id: 'room', name: 'Rooms' },
];

const MODE_PERM_COLS: { id: keyof ModePerms; name: string; desc: string }[] = [
  { id: 'edit', name: 'Edit', desc: 'The Edit floorplan tab — draw rooms, place units, upload plans' },
  { id: 'assign', name: 'Assignment', desc: 'The Assignment tab — give desks/lockers/stalls to people' },
  { id: 'book', name: 'Booking', desc: 'The Booking tab — reserve hot desks, rooms, parking' },
];

const SLOT_OPTIONS = [
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
];

export function SettingsScreen() {
  const { state, actions } = useFloorplan();

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.headRow}>
          <div>
            <div className={styles.eyebrow}>Workplace administration</div>
            <h1 className={styles.h1}>Settings</h1>
          </div>
          <Button variant="secondary" onClick={actions.openMap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to floorplan
          </Button>
        </div>

        <div className={styles.tabs}>
          {MODULE_TABS.map((t) => (
            <button
              key={t.id}
              className={[styles.tab, state.settingsTab === t.id ? styles.tabActive : ''].join(' ')}
              onClick={() => actions.setSettingsTab(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>

        {state.settingsTab === 'permissions' ? (
          <PermissionsTab />
        ) : state.settingsTab === 'bookings' ? (
          <BookingsSettingsTab />
        ) : (
          <ModuleTab type={state.settingsTab} />
        )}
      </div>
    </div>
  );
}

const BOOKING_MODULES: { id: 'space' | 'facility'; name: string; desc: string }[] = [
  { id: 'space', name: 'Space booking', desc: 'Book desks, rooms and parking directly for a time window (Facilio spacebooking module).' },
  { id: 'facility', name: 'Facility booking', desc: 'Book facilities by generated time slots — hot desks, bookable amenities (Facilio facilitybooking module).' },
];

function BookingsSettingsTab() {
  const { state, actions } = useFloorplan();
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle}>Booking module</h3>
          <p className={styles.cardDesc}>
            Choose how bookings are made across the app. Only one can be active at a time — every booking (calendar and floor plan) routes through the
            selected module.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
        {BOOKING_MODULES.map((m) => {
          const active = state.bookingModule === m.id;
          return (
            <button
              key={m.id}
              onClick={() => actions.setBookingModule(m.id)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textAlign: 'left',
                padding: '14px 16px',
                borderRadius: 10,
                border: `1.5px solid ${active ? 'var(--blue-500)' : 'var(--ink-200)'}`,
                background: active ? 'var(--blue-025)' : '#fff',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  marginTop: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: `2px solid ${active ? 'var(--blue-500)' : 'var(--ink-300)'}`,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {active && <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--blue-500)' }} />}
              </span>
              <span>
                <span style={{ display: 'block', font: '600 14px/1.2 var(--font-sans)', color: 'var(--ink-900)' }}>{m.name}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 12.5, color: 'var(--ink-600)' }}>{m.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className={styles.footNote}>
        Currently active: <b>{BOOKING_MODULES.find((m) => m.id === state.bookingModule)?.name}</b>. Bookings are also saved locally for now — real{' '}
        {state.bookingModule === 'space' ? 'spacebooking' : 'facilitybooking'} records are written when the backend is reachable.
      </div>
      {/* "This is me" picker removed: who-you-are resolves from the login session's people id at
          boot (fetchCurrentPeopleId) — desks.clientcontact_desks holds that id, so My desk /
          My bookings / the "Your desk" badge follow the real login with no manual mapping. */}
    </div>
  );
}

/**
 * Permissions are ORG-DRIVEN: a custom module (named below) holds one record per role — a role
 * lookup plus boolean fields whose names contain edit/assign/book. The signed-in user's roleId
 * picks their record; its values show/hide the floorplan's Edit/Assignment/Booking tabs. No
 * record (or no module) -> the default toggles below apply. This replaced the local
 * role-matrix ("Roles & access") on request.
 */
function PermissionsTab() {
  const { state, actions } = useFloorplan();
  const [records, setRecords] = useState<RolePermRecord[]>([]);
  // The last-saved copy — toggles edit `records` LOCALLY; "Save changes" diffs against this and
  // writes only the flipped flags to the module.
  const [savedRecords, setSavedRecords] = useState<RolePermRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const loadRecords = async (moduleName: string) => {
    if (!moduleName.trim() || !isFacilioApiConfigured) {
      setRecords([]);
      setSavedRecords([]);
      setLoadedFor(moduleName.trim() || null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchRolePermissionRecords(moduleName);
      setRecords(list);
      setSavedRecords(list.map((r) => ({ ...r, values: { ...r.values } })));
      setLoadedFor(moduleName.trim());
    } catch (err) {
      setRecords([]);
      setSavedRecords([]);
      setLoadError((err as Error).message || 'fetch failed');
      setLoadedFor(moduleName.trim());
    } finally {
      setLoading(false);
    }
  };

  // Auto-load once for the persisted module name.
  useEffect(() => {
    if (state.permsModuleName.trim() && loadedFor === null && !loading) void loadRecords(state.permsModuleName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.permsModuleName]);

  // Org roles for the per-record role picker (name display + add-role options).
  const [orgRoles, setOrgRoles] = useState<OrgRole[]>([]);
  useEffect(() => {
    if (isFacilioApiConfigured) void fetchOrgRoles().then(setOrgRoles);
  }, []);
  const roleNameOf = (id: number) => orgRoles.find((r) => r.id === id)?.name ?? `#${id}`;

  /** LOCAL flip only — nothing hits the API until "Save changes". */
  const toggleRecord = (rec: RolePermRecord, perm: keyof ModePerms) => {
    setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, values: { ...r.values, [perm]: !(r.values[perm] ?? false) } } : r)));
  };
  /** LOCAL role-list edit — saved together with the toggles. */
  const setRecordRoles = (rec: RolePermRecord, roleIds: number[]) => {
    setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, roleIds } : r)));
  };

  const savedOf = (id: number) => savedRecords.find((r) => r.id === id);
  const permChanges = records.flatMap((rec) =>
    MODE_PERM_COLS.filter((c) => rec.fieldKeys[c.id] && (rec.values[c.id] ?? false) !== (savedOf(rec.id)?.values[c.id] ?? false)).map((c) => ({
      rec,
      perm: c.id,
      value: rec.values[c.id] ?? false,
    }))
  );
  const roleChanges = records.filter((rec) => {
    const saved = savedOf(rec.id)?.roleIds ?? [];
    return rec.roleIds.length !== saved.length || rec.roleIds.some((id) => !saved.includes(id));
  });
  const pendingCount = permChanges.length + roleChanges.length;

  const saveChanges = async () => {
    if (!pendingCount) return;
    setSaving(true);
    const [permResults, roleResults] = await Promise.all([
      Promise.all(permChanges.map((c) => updateRolePermissionRecord(state.permsModuleName, c.rec, c.perm, c.value).catch(() => false))),
      Promise.all(roleChanges.map((rec) => updateRolePermissionRoles(state.permsModuleName, rec.id, rec.roleIds).catch(() => false))),
    ]);
    const failedPerms = permChanges.filter((_, i) => !permResults[i]);
    const failedRoles = roleChanges.filter((_, i) => !roleResults[i]);
    // Successes become the new saved baseline; failures revert locally so the table never
    // shows a state the module doesn't have.
    setSavedRecords((prev) =>
      prev.map((r) => {
        const next = { ...r, values: { ...r.values } };
        permChanges.forEach((c, i) => {
          if (permResults[i] && c.rec.id === r.id) next.values[c.perm] = c.value;
        });
        roleChanges.forEach((rec, i) => {
          if (roleResults[i] && rec.id === r.id) next.roleIds = [...rec.roleIds];
        });
        return next;
      })
    );
    if (failedPerms.length || failedRoles.length) {
      setRecords((rs) =>
        rs.map((r) => {
          const next = { ...r, values: { ...r.values } };
          for (const f of failedPerms) if (f.rec.id === r.id) next.values[f.perm] = !f.value;
          for (const f of failedRoles) if (f.id === r.id) next.roleIds = [...(savedOf(r.id)?.roleIds ?? [])];
          return next;
        })
      );
      actions.showToast(`${failedPerms.length + failedRoles.length} of ${pendingCount} permission change(s) failed to save`, { variant: 'error' });
    } else {
      actions.showToast(`${pendingCount} permission change(s) saved`);
    }
    // The signed-in user's own tabs may have just changed.
    void actions.refreshModePerms();
    setSaving(false);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Permissions module</h3>
            <p className={styles.cardDesc}>
              The custom module that stores per-role floorplan permissions — one record per role, with a role lookup and boolean fields named with
              edit / assign / book. The signed-in user&rsquo;s role picks their record; its values show or hide the Edit, Assignment and Booking tabs.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={state.permsModuleName}
            onChange={(e) => actions.setPermsModuleName(e.target.value)}
            placeholder="Custom module name (e.g. floorplanpermissions)"
            style={{ flex: '1 1 260px', maxWidth: 380, padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--ink-200)', font: '500 13.5px var(--font-sans)', color: 'var(--ink-900)', background: '#fff' }}
          />
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => {
              void loadRecords(state.permsModuleName);
              void actions.refreshModePerms(state.permsModuleName);
            }}
          >
            {loading ? 'Loading…' : 'Load records'}
          </Button>
        </div>
        {!isFacilioApiConfigured && <div className={styles.footNote}>No backend configured — only the default toggles below apply.</div>}
        {loadError && <div className={styles.footNote} style={{ color: 'var(--danger-700)' }}>Couldn&rsquo;t load “{state.permsModuleName}”: {loadError}</div>}
        {loadedFor && !loadError && !loading && records.length === 0 && isFacilioApiConfigured && (
          <div className={styles.footNote}>No records in “{loadedFor}” — every user gets the defaults below.</div>
        )}
        {records.length > 0 && (
          <>
            <div className={styles.matrixHead}>
              <span>Role</span>
              {MODE_PERM_COLS.map((c) => (
                <span key={c.id} className={styles.matrixHeadCell}>
                  {c.name}
                </span>
              ))}
            </div>
            {records.map((rec) => (
              <div key={rec.id} className={styles.matrixRow}>
                <div>
                  <div className={styles.rowName}>{rec.label}</div>
                  {/* Roles edited HERE (multi-lookup): chips remove, the select adds — all
                      local until Save changes writes the record's role list back. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, alignItems: 'center' }}>
                    {rec.roleIds.map((id) => (
                      <span
                        key={id}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px 2px 8px', borderRadius: 999, background: 'var(--blue-025)', border: '1px solid var(--blue-200)', font: '500 11.5px var(--font-sans)', color: 'var(--blue-700)' }}
                      >
                        {roleNameOf(id)}
                        <button
                          title="Remove role"
                          onClick={() => setRecordRoles(rec, rec.roleIds.filter((x) => x !== id))}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--blue-600)', font: '700 12px/1 var(--font-sans)', padding: 0 }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <select
                      value=""
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        if (id) setRecordRoles(rec, [...rec.roleIds, id]);
                      }}
                      style={{ padding: '2px 6px', borderRadius: 6, border: '1px dashed var(--ink-300)', font: '500 11.5px var(--font-sans)', color: 'var(--ink-600)', background: '#fff', cursor: 'pointer' }}
                    >
                      <option value="">+ Add role</option>
                      {orgRoles
                        .filter((r) => !rec.roleIds.includes(r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                {MODE_PERM_COLS.map((c) => (
                  <div key={c.id} className={styles.switchCell}>
                    {rec.fieldKeys[c.id] ? (
                      <button
                        className={[styles.switch, rec.values[c.id] ? styles.switchOn : ''].join(' ')}
                        onClick={() => toggleRecord(rec, c.id)}
                      >
                        <span className={styles.knob} style={{ left: rec.values[c.id] ? 18 : 2 }} />
                      </button>
                    ) : (
                      <span className={styles.rowDesc}>—</span>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {/* Batched save on request: toggles/roles above only edit locally; this writes the diff. */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 12 }}>
              {pendingCount > 0 && (
                <span className={styles.rowDesc}>
                  {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}
                </span>
              )}
              <Button variant="primary" disabled={saving || pendingCount === 0} onClick={() => void saveChanges()}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Default permissions</h3>
            <p className={styles.cardDesc}>
              Applied when no module record matches the signed-in user&rsquo;s role (or no module is set). Saved with your workspace settings.
            </p>
          </div>
        </div>
        {MODE_PERM_COLS.map((c) => (
          <div key={c.id} className={styles.stateRow}>
            <div className={styles.stateText}>
              <div className={styles.rowName}>{c.name}</div>
              <div className={styles.rowDesc}>{c.desc}</div>
            </div>
            <button
              className={[styles.switch, state.defaultModePerms[c.id] ? styles.switchOn : ''].join(' ')}
              onClick={() => actions.toggleDefaultModePerm(c.id)}
            >
              <span className={styles.knob} style={{ left: state.defaultModePerms[c.id] ? 18 : 2 }} />
            </button>
          </div>
        ))}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Local data</h3>
            <p className={styles.cardDesc}>
              In local dev the app seeds from the editable JSON in <code>src/data</code> (sites,
              people, assets, spaces, bookings) and layers this session&rsquo;s edits on top in the
              browser. Clearing wipes those local edits and reloads, re-seeding from the repo JSON
              (and any live Facilio API data in connected-app mode).
            </p>
          </div>
          <Button variant="secondary" onClick={actions.clearCaches}>
            Clear local data
          </Button>
        </div>
        <div className={styles.stateRow}>
          <div className={styles.stateText}>
            <div className={styles.rowName}>Allow local data as a fallback</div>
            <div className={styles.rowDesc}>
              When off, a failure loading your organization&rsquo;s real data shows an error
              instead of silently falling back to local/seed data.
            </div>
          </div>
          <AllowLocalFallbackSwitch />
        </div>
      </div>
    </div>
  );
}

function AllowLocalFallbackSwitch() {
  const { state, actions } = useFloorplan();
  const on = state.allowLocalFallback;
  return (
    <button className={[styles.switch, on ? styles.switchOn : ''].join(' ')} onClick={() => actions.setAllowLocalFallback(!on)}>
      <span className={styles.knob} style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

function ModuleTab({ type }: { type: UnitType }) {
  const { state, actions } = useFloorplan();
  const defs = STATE_DEFS[type];
  const showSlot = type !== 'locker';

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>States &amp; color coding</h3>
          <p className={styles.cardDesc}>Pick the color used on the floorplan and legend for each state.</p>
        </div>
        {defs.map((s) => (
          <div key={s.key} className={styles.stateRow}>
            <span className={styles.stateSwatch} style={{ background: moduleColor(state, type, s.key) }} />
            <div className={styles.stateText}>
              <div className={styles.rowName}>{s.label}</div>
              <div className={styles.rowDesc}>{s.desc}</div>
            </div>
            <div className={styles.swatchRow}>
              {STATE_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  title={hex}
                  className={styles.swatchBtn}
                  style={{
                    background: hex,
                    boxShadow: moduleColor(state, type, s.key) === hex ? '0 0 0 2px #fff, 0 0 0 4px var(--blue-500)' : 'none',
                  }}
                  onClick={() => actions.setModuleColor(`${type}.${s.key}`, hex)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {showSlot && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>Default slot length</h3>
            <p className={styles.cardDesc}>New bookings start at this length. Drag the calendar edges to fine-tune any booking.</p>
          </div>
          <div className={styles.slotRow}>
            {SLOT_OPTIONS.map((o) => (
              <button
                key={o.minutes}
                className={[styles.slotChip, state.slotGranularity === o.minutes ? styles.slotChipActive : ''].join(' ')}
                onClick={() => actions.setSlotGranularity(o.minutes)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
