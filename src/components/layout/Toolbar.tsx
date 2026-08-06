import { useFloorplan } from '../../state/FloorplanContext';
import { myAssignedUnit } from '../../state/selectors';
import styles from './Toolbar.module.css';

export function Toolbar({ leftPad, rightPad }: { leftPad: number; rightPad: number }) {
  const { state, actions } = useFloorplan();
  // No mode tabs at all -> no floating bar. A view-only user just gets the plan.
  if (!state.modePerms.edit && !state.modePerms.assign && !state.modePerms.book) return null;
  const myUnit = myAssignedUnit(state);
  // Mock tier derives "my desk" from local assignments; the real backend provides it via
  // servicePortalHome (state.myDesk). Either one lights the button up.
  const hasMyDesk = !!myUnit || !!state.myDesk;

  function onMyDesk() {
    if (myUnit) actions.focusUnit(myUnit.id, state.stage.w, state.stage.h, { select: false });
    else actions.locateMyDesk(state.stage.w, state.stage.h);
  }

  return (
    <div className={styles.wrap} style={{ paddingLeft: leftPad, paddingRight: rightPad }}>
      <div className={styles.pill}>
        {/* Mode tabs are PERMISSION-gated: state.modePerms resolves from the org's
            role-permissions module (by the session user's role), falling back to the Settings
            defaults — see Settings › Permissions. */}
        {(state.modePerms.assign || state.modePerms.book) && (
          <div className={styles.segment}>
            {state.modePerms.assign && (
              <button className={[styles.segBtn, state.mode === 'assign' ? styles.segBtnActive : ''].join(' ')} onClick={() => actions.setMode('assign')}>
                Assignment
              </button>
            )}
            {state.modePerms.book && (
              <button className={[styles.segBtn, state.mode === 'book' ? styles.segBtnActive : ''].join(' ')} onClick={() => actions.setMode('book')}>
                Booking
              </button>
            )}
          </div>
        )}

        {state.modePerms.edit && (
          <button
            className={[styles.editBtn, state.mode === 'edit' ? styles.editBtnActive : ''].join(' ')}
            data-tip={state.mode === 'edit' ? 'Exit edit mode' : 'Edit floorplan'}
            data-tip-align="center"
            data-tip-pos="top"
            onClick={actions.toggleEdit}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Edit
          </button>
        )}

        {/* Personal wayfinding has no place while editing the plan itself. */}
        {hasMyDesk && state.mode !== 'edit' && (
          <button className={styles.myDesk} data-tip="Locate my desk" data-tip-align="center" data-tip-pos="top" onClick={onMyDesk}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            My desk
          </button>
        )}

        <button
          className={[styles.iconToggle, state.panels.details.open ? styles.iconToggleActive : ''].join(' ')}
          data-tip="Toggle details panel"
          data-tip-align="center"
          data-tip-pos="top"
          onClick={() => actions.togglePanelOpen('details')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
