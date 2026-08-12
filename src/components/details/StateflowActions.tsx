import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { resolveUnitRecordRef } from '../../lib/facilioApiDataSource';
import {
  executeApprovalTransition,
  executeStateTransition,
  fetchApprovalTransitions,
  fetchAvailableStates,
  isAssignTransition,
  isVacateTransition,
  type FlowState,
  type TransitionOption,
} from '../../lib/stateflowApi';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { StatusPill } from '../primitives/StatusPill';
import type { Unit } from '../../lib/types';

/**
 * Stateflow + approval actions for ONE real backend record — the floorplan app's equivalent of
 * clientV2's transition buttons + ApprovalBar, module-agnostic: give it a moduleName + recordId
 * and it renders the record's current state, its available state transitions, and (when the
 * record is under an approval flow) the Approve/Reject/... actions. Every button click fires the
 * corresponding transition API (see stateflowApi) and refetches on success.
 *
 * Renders nothing in pure local mode and swallows fetch errors into "no section" — stateflow is
 * strictly additive chrome over the real backend, never a blocker (same tier-fallback philosophy
 * as the data sources).
 */
export function StateflowActions({
  moduleName,
  recordId,
  showApproval = true,
  showStatusRow = true,
  readOnly = false,
  onChanged,
  onTransitionStart,
  onTransitionDone,
  hideTransition,
  replaceTransition,
  refreshKey,
  unitId,
}: {
  moduleName: string;
  recordId: number;
  showApproval?: boolean;
  showStatusRow?: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
  /** Called the moment a transition is CLICKED (before the API round-trip) — for callers that open follow-up UI instantly (e.g. Re-Assign opening the person picker). Return true to SUPPRESS the "<name> done" toast: the follow-up UI is the feedback, and the toast covered the picker. Return 'defer' to ALSO skip the request itself: the caller runs the transition later, once its follow-up UI has produced the data the transition is about (an assign needs a person first). */
  onTransitionStart?: (t: TransitionOption) => void | boolean | 'defer';
  /** Drop a state transition from the button bar — for surfaces that offer the same act through their own UI (an assign handled by the person picker) and would otherwise show two buttons for it. */
  hideTransition?: (t: TransitionOption) => boolean;
  /**
   * Render the caller's OWN control in place of a transition, in the same slot. Used for an act
   * the app performs differently than a plain transition (assigning writes the record via the
   * person picker) while keeping the API as the authority on whether it's offered at all: no
   * transition from the backend for this record and user, no button.
   */
  replaceTransition?: (t: TransitionOption) => ReactNode | null;
  /** Bump to re-read the record's state — e.g. after an assignment changed it from outside. */
  refreshKey?: number;
  /** Called after a transition executes successfully, with the transition that ran — for callers that mirror specific transitions into app state (e.g. a desk Vacate clearing the assignee). */
  onTransitionDone?: (t: TransitionOption) => void;
  /** The unit this record belongs to, when mounted for one — scopes the popup loader flag this clears. */
  unitId?: string;
}) {
  const { actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [approval, setApproval] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [readsSettled, setReadsSettled] = useState(false);

  /**
   * SELF-HEALING clear for the popup's loader flag.
   *
   * Several surfaces mount a section for the SAME unit at once — the assignment panel and the map
   * popup, most commonly. Each new section sets the flag on mount, but this component's read effect
   * only clears it when its own deps change, so a section mounting AFTER these reads settled (the
   * popup opening over an already-loaded panel) set a flag nothing was left to clear: the panel
   * showed the record in full while the popup shimmered forever beside it.
   *
   * Running on every render once the reads have settled makes stranding it impossible, whatever the
   * mount order. It's a no-op — and provokes no re-render, since the reducer returns the same state
   * — unless the flag is actually set for this unit.
   */
  useEffect(() => {
    if (readsSettled && unitId) actions.setFlowPending(null, unitId);
  });

  /**
   * DROP THE PREVIOUS RECORD'S ANSWERS THE MOMENT THE RECORD CHANGES.
   *
   * `flow`/`approval` used to survive until the new read resolved, so selecting a different unit
   * rendered the OLD record's state pill and transition buttons under the NEW record's name — a
   * free room showed "Assigned" with a Re-assign button for as long as the read took, then swapped
   * to "Assignable / Assign a person". That swap is what reads as flickering, and it is not merely
   * cosmetic: those buttons were live, so a click acted on the newly selected record using a
   * transition offered for the previous one.
   *
   * Adjusted during render (React's supported pattern for state derived from changing props) rather
   * than in an effect, because an effect would still let one frame paint the stale answer — exactly
   * the frame captured in the report.
   *
   * Keyed on record IDENTITY only: `refreshKey`/`nonce` re-read the SAME record after an action, and
   * blanking the section on those would replace one flicker with another.
   */
  const identity = `${moduleName}:${recordId}`;
  const lastIdentity = useRef(identity);
  if (lastIdentity.current !== identity) {
    lastIdentity.current = identity;
    setFlow(null);
    setApproval(null);
    setReadsSettled(false);
  }

  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    let cancelled = false;
    setReadsSettled(false);
    const flowRead = fetchAvailableStates(moduleName, recordId)
      .then((f) => {
        if (!cancelled) setFlow(f);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[stateflow] getAvailableState failed for ${moduleName}/${recordId}`, err);
        if (!cancelled) setFlow(null);
      });
    let approvalRead: Promise<unknown> = Promise.resolve();
    if (showApproval) {
      approvalRead = fetchApprovalTransitions(moduleName, recordId)
        .then((f) => {
          if (!cancelled) setApproval(f);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[stateflow] availableTransitions failed for ${moduleName}/${recordId}`, err);
          if (!cancelled) setApproval(null);
        });
    }
    // Cleared once BOTH reads have settled — that is the moment the section can render its final
    // shape, and therefore the moment the popup may stop loading. Scoped to this unit when we know
    // it, so a late-settling read for one unit can't stop another unit's loader early.
    Promise.allSettled([flowRead, approvalRead]).then(() => {
      if (cancelled) return;
      setReadsSettled(true);
      actions.setFlowPending(null, unitId);
    });
    return () => {
      cancelled = true;
    };
  }, [moduleName, recordId, showApproval, nonce, refreshKey]);

  if (!isFacilioApiConfigured) return null;
  const stateTransitions = (flow?.transitions ?? []).filter((t) => !hideTransition?.(t));
  const approvalTransitions = approval?.transitions ?? [];
  const hasAnything = flow?.currentStateName || approval?.currentStateName || stateTransitions.length > 0 || approvalTransitions.length > 0;
  if (!hasAnything) return null;

  const run = async (kind: 'state' | 'approval', t: TransitionOption) => {
    // commentRequired: v1 collects the comment via a plain prompt (clientV2 renders a comment
    // box); the payload shape matches what the real client sends.
    let data: Record<string, unknown> | undefined;
    if (t.commentRequired) {
      const body = window.prompt(`Comment for “${t.name}”`);
      if (body === null) return; // aborted — no request
      data = { transitionCommentData: { body, bodyHTML: body } };
    }
    const started = onTransitionStart?.(t);
    // DEFERRED: the caller opened UI that must produce something first (the person picker for an
    // assign) and will run the transition itself once it has it — firing it now would move the
    // record's state with nobody assigned (reported).
    if (started === 'defer') return;
    setBusyId(`${kind}:${t.id}`);
    const openedFollowUp = started === true;
    try {
      if (kind === 'state') await executeStateTransition(moduleName, recordId, t.id, data);
      else await executeApprovalTransition(moduleName, recordId, t.id, data);
      if (!openedFollowUp) actions.showToast(`${t.name} done`);
      // Refetch immediately, then ONCE more shortly after: the transition PATCH can return
      // before the new state is readable, so the first read came back with the OLD state and the
      // buttons stayed as they were (reported — "vacate is done but the details didn't update").
      setNonce((n) => n + 1);
      window.setTimeout(() => setNonce((n) => n + 1), 900);
      onTransitionDone?.(t);
      onChanged?.();
    } catch (err) {
      actions.showToast(`${t.name} failed: ${(err as Error).message || 'unknown error'}`);
    } finally {
      setBusyId(null);
    }
  };

  // One ordered action list (approval actions first, then state transitions). Display rule:
  // 1st action = primary (blue), 2nd = secondary (white + outline), everything else collapses
  // behind a "⋯" more-actions dropdown — matching the real client's button bar.
  const allActions: { kind: 'state' | 'approval'; t: TransitionOption }[] = [
    ...approvalTransitions.map((t) => ({ kind: 'approval' as const, t })),
    ...stateTransitions.map((t) => ({ kind: 'state' as const, t })),
  ];
  const visible = allActions.slice(0, 2);
  const overflow = allActions.slice(2);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      {/* Just the pills, no "Status" label. When the record's state name is itself approval-speak
          ("Approval Pending") AND the approval flow has a status, the two pills said the same
          thing twice — collapse to ONE amber approval pill; the blue state pill only shows when
          it carries distinct information (e.g. "Occupied"). */}
      {showStatusRow &&
        (() => {
          const stateName = flow?.currentStateName ?? null;
          const approvalName = approval?.currentStateName ?? null;
          const stateIsApprovalSpeak = !!stateName && /approval|pending|requested|waiting/i.test(stateName);
          const approvalLabel = approvalName ? (/pending|requested|waiting/i.test(approvalName) ? 'Approval pending' : `Approval · ${approvalName}`) : null;
          const showState = !!stateName && !(stateIsApprovalSpeak && approvalLabel);
          if (!showState && !approvalLabel) return null;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {showState && <StatusPill label={stateName!} bg="var(--blue-025)" fg="var(--blue-700)" />}
              {approvalLabel && <StatusPill label={approvalLabel} bg="var(--warning-050)" fg="var(--warning-700)" />}
            </div>
          );
        })()}
      {!readOnly && allActions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
          {visible.map(({ kind, t }, i) => {
            // The caller may own this act (assign) — its control takes the transition's slot.
            const replacement = kind === 'state' ? replaceTransition?.(t) : null;
            if (replacement) return <span key={`${kind}${t.id}`} style={{ display: 'contents' }}>{replacement}</span>;
            return (
              <Button key={`${kind}${t.id}`} variant={i === 0 ? 'primary' : 'secondary'} disabled={busyId !== null} onClick={() => run(kind, t)}>
                {busyId === `${kind}:${t.id}` ? <ButtonSpinner /> : t.name}
              </Button>
            );
          })}
          {overflow.length > 0 && (
            <>
              <Button
                variant="secondary"
                aria-label="More actions"
                aria-expanded={menuOpen}
                disabled={busyId !== null}
                onClick={() => setMenuOpen((o) => !o)}
                style={{ paddingLeft: 10, paddingRight: 10, fontWeight: 700, letterSpacing: 1 }}
              >
                ⋯
              </Button>
              {menuOpen && (
                <>
                  {/* click-away backdrop */}
                  <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setMenuOpen(false)} />
                  <div
                    role="menu"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      zIndex: 31,
                      minWidth: 160,
                      background: '#fff',
                      border: '1px solid var(--ink-200)',
                      borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
                      padding: 4,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    {overflow.map(({ kind, t }) => (
                      <button
                        key={`${kind}${t.id}`}
                        role="menuitem"
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => {
                          setMenuOpen(false);
                          void run(kind, t);
                        }}
                        style={{
                          textAlign: 'left',
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          font: '500 13px/1.2 var(--font-sans)',
                          color: 'var(--ink-800)',
                        }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--ink-050)')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Unit-level wrapper: resolves the placed unit's real backend record (read-only — a unit with no
 * record yet, a room/amenity that can't resolve, or local mode all render nothing) and mounts
 * StateflowActions for it.
 */
export function UnitStateflowSection({ unit, readOnly, showStatusRow }: { unit: Unit; readOnly?: boolean; showStatusRow?: boolean }) {
  const { state, actions } = useFloorplan();
  const [ref, setRef] = useState<{ moduleName: string; recordId: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRef(null);
    if (!isFacilioApiConfigured) return;
    // Tell the surfaces that this unit's stateflow read is in flight, so the popup's loader can
    // cover it: the state pill and the action buttons used to land a beat after the rest.
    actions.setFlowPending(unit.id);
    // WHOEVER SETS THE FLAG CLEARS IT. `StateflowActions` clears it once its own reads settle, but
    // it only MOUNTS when a record ref resolved — so a unit that resolves to no record (a room or
    // amenity with nothing behind it, a marker whose record was deleted) left the flag set with
    // nothing left running to clear it, and the popup shimmered forever with every response already
    // in. Reported as "the room data keeps on loading", and the same for desks.
    resolveUnitRecordRef(unit)
      .then((r) => {
        if (cancelled) return;
        setRef(r);
        if (!r) actions.setFlowPending(null, unit.id);
      })
      .catch(() => {
        if (cancelled) return;
        setRef(null);
        actions.setFlowPending(null, unit.id);
      });
    return () => {
      cancelled = true;
      // Torn down mid-read (popup closed, another unit picked): the read that would have cleared
      // this is now abandoned, so the flag must not outlive the section that set it. Conditional,
      // so it can't cancel the loader of a unit whose read started after this one.
      actions.setFlowPending(null, unit.id);
    };
  }, [unit.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ref) return null;
  return (
    <StateflowActions
      moduleName={ref.moduleName}
      recordId={ref.recordId}
      readOnly={readOnly}
      showStatusRow={showStatusRow}
      // Scopes the loader flag this clears — several surfaces mount a section for the same unit.
      unitId={unit.id}
      // Re-read the record's state after ANY action on this unit (assign, vacate, a transition
      // run elsewhere) so the popup never shows the pre-action state.
      refreshKey={state.unitNonce}
      onChanged={() => actions.unitChanged()}
      // ONE assign button, and only when the API offers the act (requested — assign/vacate/
      // re-assign must not show for everyone). The record's assign-ish transition keeps its slot
      // but renders OUR control: the app assigns by writing the record through the person picker,
      // not by firing the transition. No assign transition for this record and user -> no button
      // at all. Vacate is untouched: it stays a real transition button.
      replaceTransition={(t) => {
        if (readOnly || !isAssignTransition(t)) return null;
        // The LABEL follows the transition the API offered (Re-Assign vs Assign) and falls back to
        // the local map — reading the map alone showed "Assign a person" on a desk the record
        // says is Occupied (reported).
        const held = /re-?assign/i.test(t.name) || !!state.assignments[unit.id];
        return (
          <Button variant={held ? 'secondary' : 'primary'} onClick={() => actions.openPeoplePicker(unit.id)}>
            {held ? 'Re-assign' : 'Assign a person'}
          </Button>
        );
      }}
      // Belt and braces for a surface that DOES show an assign transition (a read-only one never
      // renders buttons, so today nothing does): it opens the person picker and stops there —
      // assigning is a record write, so the transition must not fire on the click.
      onTransitionStart={(t) => {
        if (isAssignTransition(t)) {
          actions.openPeoplePicker(unit.id);
          return 'defer';
        }
        return false;
      }}
      // A vacate-ish transition must ALSO clear the record's assignee lookup (the transition only
      // changes state) — clientcontact_moves: null on desks, employee: null on lockers/parking —
      // and drop the local assignment so the overlay updates immediately.
      onTransitionDone={(t) => {
        if (isVacateTransition(t)) actions.stateflowVacated(unit.id);
      }}
    />
  );
}
