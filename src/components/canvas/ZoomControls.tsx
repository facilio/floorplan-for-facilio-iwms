import { useFloorplan } from '../../state/FloorplanContext';
import { IMG_W } from '../../lib/mockData';
import styles from './ZoomControls.module.css';

export function ZoomControls({ rectW, rectH }: { rectW: number; rectH: number }) {
  const { state, actions } = useFloorplan();
  const zoomPct = Math.round(state.view.z * 100) + '%';
  const scaleText = state.pxPerMeter ? `${(state.pxPerMeter / state.view.z).toFixed(0)} px/m` : `${IMG_W}px plan`;

  return (
    <div className={styles.wrap}>
      <span className={styles.readout}>
        {scaleText} · {zoomPct}
      </span>
      <div className={styles.group}>
        <button className={styles.btn} title="Zoom in" onClick={() => actions.zoomIn(rectW, rectH)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button className={[styles.btn, styles.btnLast].join(' ')} title="Zoom out" onClick={() => actions.zoomOut(rectW, rectH)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <button className={styles.fit} title="Fit to view" onClick={() => actions.fitView(rectW, rectH)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>
    </div>
  );
}
