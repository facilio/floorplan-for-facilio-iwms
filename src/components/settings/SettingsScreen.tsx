import { useFloorplan } from '../../state/FloorplanContext';
import { ACTIONS, ROLES, STATE_DEFS, STATE_SWATCHES } from '../../lib/types';
import type { PermsAction, Role, UnitType } from '../../lib/types';
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
      <div className={styles.cardHead} style={{ marginTop: 18 }}>
        <div>
          <h3 className={styles.cardTitle}>This is me</h3>
          <p className={styles.cardDesc}>
            Which client contact you are — drives “My bookings”, the “Your desk” badge and booking defaults. There’s no backend mapping from your login
            to a client contact yet, so pick yourself here once per device.
          </p>
        </div>
      </div>
      <select
        value={state.clientContacts.some((c) => c.id === state.bookBy) ? state.bookBy : ''}
        onChange={(e) => actions.setBookField('bookBy', e.target.value)}
        style={{ padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--ink-200)', font: '500 13.5px var(--font-sans)', color: 'var(--ink-900)', background: '#fff', maxWidth: 360 }}
      >
        <option value="" disabled>
          Select your client contact…
        </option>
        {state.clientContacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.client ? ` — ${c.client}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function PermissionsTab() {
  const { state, actions } = useFloorplan();
  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Roles &amp; access</h3>
            <p className={styles.cardDesc}>Choose which roles can perform each action. Changes apply immediately and are saved for your workspace.</p>
          </div>
          <Button variant="secondary" onClick={actions.resetPerms}>
            Reset to defaults
          </Button>
        </div>
        <div className={styles.matrixHead}>
          <span>Action</span>
          {ROLES.map((r) => (
            <span key={r.id} className={styles.matrixHeadCell}>
              {r.name}
            </span>
          ))}
        </div>
        {ACTIONS.map((a) => (
          <div key={a.id} className={styles.matrixRow}>
            <div>
              <div className={styles.rowName}>{a.name}</div>
              <div className={styles.rowDesc}>{a.desc}</div>
            </div>
            {ROLES.map((r) => (
              <div key={r.id} className={styles.switchCell}>
                <PermSwitch action={a.id} role={r.id} />
              </div>
            ))}
          </div>
        ))}
        <div className={styles.footNote} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>
            Preview the app as a role:
          </span>
          <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'var(--ink-050)', border: '1px solid var(--ink-200)', borderRadius: 8 }}>
            {ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => actions.setRole(r.id)}
                style={{
                  height: 28,
                  padding: '0 12px',
                  border: 'none',
                  borderRadius: 6,
                  background: state.role === r.id ? 'var(--blue-500)' : 'transparent',
                  color: state.role === r.id ? '#fff' : 'var(--ink-600)',
                  font: '600 12px/1 var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
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

function PermSwitch({ action, role }: { action: PermsAction; role: Role }) {
  const { state, actions } = useFloorplan();
  const on = state.perms[action].includes(role);
  return (
    <button className={[styles.switch, on ? styles.switchOn : ''].join(' ')} onClick={() => actions.togglePerm(action, role)}>
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
