import { useFloorplan } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { PLAN_TYPE_MAPS, PLAN_TYPE_NAME } from '../../lib/types';
import { Button } from '../primitives/Button';

export function EmptyPlanState() {
  const { state, actions } = useFloorplan();
  const floor = floorMeta(state, state.floorId)?.floor;
  const planName = PLAN_TYPE_NAME[state.planId];

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <div style={{ width: 96, height: 96, borderRadius: 16, background: 'var(--brand-indigo-050)', display: 'grid', placeItems: 'center', color: 'var(--brand-indigo)', marginBottom: 14 }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3L4 5v16l5-2 6 2 5-2V3l-5 2-6-2z M9 3v16M15 5v16" />
        </svg>
      </div>
      <h3 style={{ fontSize: 16, color: 'var(--ink-900)', margin: '0 0 4px' }}>No {planName} floorplan yet</h3>
      <p style={{ fontSize: 13, color: 'var(--ink-600)', margin: 0, maxWidth: 320 }}>
        Upload a rendered plan for {floor?.name ?? 'this floor'} to start mapping {PLAN_TYPE_MAPS[state.planId]}.
      </p>
      <Button variant="secondary" style={{ marginTop: 14 }} onClick={() => actions.setUploadOpen(true)}>
        Upload floorplan
      </Button>
    </div>
  );
}
