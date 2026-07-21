import { useFloorplan } from '../../state/FloorplanContext';
import { moduleColor } from '../../lib/unitStatus';
import { AMENITY_META } from '../../lib/types';
import type { AmenityIcon } from '../../lib/types';

export function Legend() {
  const { state } = useFloorplan();

  let items: { label: string; color: string }[];
  if (state.mode === 'edit') {
    items = [
      { label: 'Desk', color: moduleColor(state, 'workstation', 'free') },
      { label: 'Locker', color: moduleColor(state, 'locker', 'free') },
      { label: 'Parking', color: moduleColor(state, 'parking', 'free') },
      { label: 'Room', color: 'rgba(60,34,157,0.62)' },
    ];
  } else if (state.mode === 'assign') {
    items = [
      { label: 'Free', color: moduleColor(state, 'workstation', 'free') },
      { label: 'Assigned', color: moduleColor(state, 'workstation', 'assigned') },
    ];
  } else {
    items = [
      { label: 'Available', color: moduleColor(state, 'room', 'available') },
      { label: 'Booked', color: moduleColor(state, 'room', 'booked') },
      { label: 'Not bookable', color: 'var(--ink-400)' },
    ];
  }

  // Add a color tag for each amenity type actually placed on this floor
  // (stairs, elevators, restrooms, …) so their marker colors are legible.
  const presentAmenities = Array.from(
    new Set(state.units.filter((u) => u.type === 'amenity' && u.icon).map((u) => u.icon as AmenityIcon)),
  );
  for (const icon of presentAmenities) {
    items.push({ label: AMENITY_META[icon].name, color: AMENITY_META[icon].color });
  }

  return (
    <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '70%' }}>
      {items.map((it) => (
        <span
          key={it.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 10px',
            background: '#fff',
            border: '1px solid var(--ink-200)',
            borderRadius: 999,
            font: '500 11px/1 var(--font-sans)',
            color: 'var(--ink-700)',
            boxShadow: 'var(--shadow-xs)',
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
