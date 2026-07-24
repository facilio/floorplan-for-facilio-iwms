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
}: {
  moduleName: string;
  recordId: number;
  showApproval?: boolean;
  showStatusRow?: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
}) {
  const { actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [approval, setApproval] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
      onChanged?.();
    } catch (err) {
      actions.showToast(`${t.name} failed: ${(err as Error).message || 'unknown error'}`);
    } finally {
      setBusyId(null);
    }
  };

  const variantFor = (name: string): 'primary' | 'danger' | 'secondary' => {
    if (/approve/i.test(name)) return 'primary';
    if (/reject|cancel/i.test(name)) return 'danger';
    return 'secondary';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      {showStatusRow && (flow?.currentStateName || approval?.currentStateName) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--ink-600)' }}>Status</span>
          {flow?.currentStateName && <StatusPill label={flow.currentStateName} bg="var(--blue-025)" fg="var(--blue-700)" />}
          {approval?.currentStateName && <StatusPill label={`Approval · ${approval.currentStateName}`} bg="var(--warning-050)" fg="var(--warning-700)" />}
        </div>
      )}
      {!readOnly && (approvalTransitions.length > 0 || stateTransitions.length > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {approvalTransitions.map((t) => (
            <Button key={`a${t.id}`} variant={variantFor(t.name)} disabled={busyId !== null} onClick={() => run('approval', t)}>
              {busyId === `approval:${t.id}` ? <ButtonSpinner /> : t.name}
            </Button>
          ))}
          {stateTransitions.map((t) => (
            <Button key={`s${t.id}`} variant={variantFor(t.name)} disabled={busyId !== null} onClick={() => run('state', t)}>
              {busyId === `state:${t.id}` ? <ButtonSpinner /> : t.name}
            </Button>
          ))}
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
  return <StateflowActions moduleName={ref.moduleName} recordId={ref.recordId} readOnly={readOnly} />;
}
