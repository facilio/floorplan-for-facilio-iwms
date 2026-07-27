import { useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { resolveUnitRecordRef } from '../../lib/facilioApiDataSource';
import {
  executeApprovalTransition,
  executeStateTransition,
  fetchApprovalTransitions,
  fetchAvailableStates,
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
  onTransitionDone,
}: {
  moduleName: string;
  recordId: number;
  showApproval?: boolean;
  showStatusRow?: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
  /** Called after a transition executes successfully, with the transition that ran — for callers that mirror specific transitions into app state (e.g. a desk Vacate clearing the assignee). */
  onTransitionDone?: (t: TransitionOption) => void;
}) {
  const { actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [approval, setApproval] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    let cancelled = false;
    fetchAvailableStates(moduleName, recordId)
      .then((f) => {
        if (!cancelled) setFlow(f);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[stateflow] getAvailableState failed for ${moduleName}/${recordId}`, err);
        if (!cancelled) setFlow(null);
      });
    if (showApproval) {
      fetchApprovalTransitions(moduleName, recordId)
        .then((f) => {
          if (!cancelled) setApproval(f);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[stateflow] availableTransitions failed for ${moduleName}/${recordId}`, err);
          if (!cancelled) setApproval(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [moduleName, recordId, showApproval, nonce]);

  if (!isFacilioApiConfigured) return null;
  const stateTransitions = flow?.transitions ?? [];
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
    setBusyId(`${kind}:${t.id}`);
    try {
      if (kind === 'state') await executeStateTransition(moduleName, recordId, t.id, data);
      else await executeApprovalTransition(moduleName, recordId, t.id, data);
      actions.showToast(`${t.name} done`);
      setNonce((n) => n + 1); // refetch own state
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
          {visible.map(({ kind, t }, i) => (
            <Button key={`${kind}${t.id}`} variant={i === 0 ? 'primary' : 'secondary'} disabled={busyId !== null} onClick={() => run(kind, t)}>
              {busyId === `${kind}:${t.id}` ? <ButtonSpinner /> : t.name}
            </Button>
          ))}
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
export function UnitStateflowSection({ unit, readOnly }: { unit: Unit; readOnly?: boolean }) {
  const { actions } = useFloorplan();
  const [ref, setRef] = useState<{ moduleName: string; recordId: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRef(null);
    if (!isFacilioApiConfigured) return;
    resolveUnitRecordRef(unit)
      .then((r) => {
        if (!cancelled) setRef(r);
      })
      .catch(() => {
        if (!cancelled) setRef(null);
      });
    return () => {
      cancelled = true;
    };
  }, [unit.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ref) return null;
  return (
    <StateflowActions
      moduleName={ref.moduleName}
      recordId={ref.recordId}
      readOnly={readOnly}
      // A vacate-ish transition must ALSO clear the record's assignee lookup (the transition only
      // changes state) — clientcontact_moves: null on desks, employee: null on lockers/parking —
      // and drop the local assignment so the overlay updates immediately. Reassignment keeps
      // flowing through the assign path, which patches the NEW contact id the same way.
      onTransitionDone={(t) => {
        if (/vacat|unassign/i.test(t.name)) actions.stateflowVacated(unit.id);
      }}
    />
  );
}
