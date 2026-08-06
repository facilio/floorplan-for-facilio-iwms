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
        <button className={styles.btn} data-tip="Zoom in" data-tip-side="left" onClick={() => actions.zoomIn(rectW, rectH)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button className={[styles.btn, styles.btnLast].join(' ')} data-tip="Zoom out" data-tip-side="left" onClick={() => actions.zoomOut(rectW, rectH)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <button
        className={[styles.fit, state.showAllLabels ? styles.fitActive : ''].join(' ')}
        data-tip={state.showAllLabels ? 'Labels: all (click for auto)' : 'Show all labels'}
        data-tip-side="left"
        onClick={actions.toggleShowAllLabels}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button className={styles.fit} data-tip="Fit to view" data-tip-side="left" onClick={() => actions.fitView(rectW, rectH)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>
    </div>
  );
}
