import { useFloorplan } from '../../state/FloorplanContext';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileTimePicker.module.css';

function clampMinutes(v: number) {
  return Math.max(0, Math.min(1439, v));
}

export function MobileTimePicker() {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(() => actions.setMobTimePick(null), !!state.mobTimePick);
  if (!state.mobTimePick) return null;

  // Step by the configured slot-granularity setting (Settings → 15m/30m/1h/2h), not a fixed 30.
  const step = state.slotGranularity;
  const current = state.mobTimePick === 'end' ? state.end : state.start;
  const hourLabel = String((Math.floor(current / 60) % 12) || 12);
  const minLabel = String(current % 60).padStart(2, '0');
  const ampm = Math.floor(current / 60) < 12 ? 'AM' : 'PM';
  const title = state.mobTimePick === 'end' ? 'End time' : 'Start time';

  function adjustPick(delta: number) {
    const editingStart = state.mobTimePick !== 'end';
    const cur = editingStart ? state.start : state.end;
    const next = clampMinutes(cur + delta);
    if (editingStart) {
      const dur = Math.max(step, state.end - state.start);
      actions.setTimeRange(next, Math.min(1439, next + dur));
    } else {
      actions.setTimeRange(state.start, Math.max(state.start + step, next));
    }
  }

  function toggleAmpm() {
    const isAm = Math.floor(current / 60) < 12;
    adjustPick(isAm ? 720 : -720);
  }

  return (
    <div className={styles.backdrop} onClick={() => actions.setMobTimePick(null)}>
      <div ref={sheetRef} className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>{title}</div>
        <div className={styles.row}>
          <Stepper label={hourLabel} onUp={() => adjustPick(60)} onDown={() => adjustPick(-60)} />
          <span className={styles.colon}>:</span>
          <Stepper label={minLabel} onUp={() => adjustPick(step)} onDown={() => adjustPick(-step)} />
          <button className={styles.ampm} onClick={toggleAmpm}>
            {ampm}
          </button>
        </div>
        <button className={styles.done} onClick={() => actions.setMobTimePick(null)}>
          Done
        </button>
      </div>
    </div>
  );
}

function Stepper({ label, onUp, onDown }: { label: string; onUp: () => void; onDown: () => void }) {
  return (
    <div className={styles.stepper}>
      <button className={styles.stepBtn} onClick={onUp}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      <span className={styles.stepLabel}>{label}</span>
      <button className={styles.stepBtn} onClick={onDown}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
