import { customGet, customPatch, customPost, facilioApi, isConnectedApp, isFacilioApiConfigured } from './facilioApi';

/**
 * Module-agnostic stateflow + approval-flow client, mirroring the real Facilio web client
 * (clientV2)'s mechanics — the same endpoints drive EVERY module (spacebooking, desks, lockers,
 * parkingstall, space), with the module name in the path/params:
 *
 *  - stateflow list:    GET  v2/statetransition/getAvailableState {moduleName, id}
 *  - stateflow execute: PATCH v3/action/{moduleName}/{recordId}/transition {id, stateTransitionId, data}
 *  - approval list:     POST v2/approval/availableTransitions {moduleName, id}
 *  - approval execute:  PATCH v3/approval/action/{moduleName}/{recordId}/approval {id, approvalTransitionId, data}
 *
 * Envelopes differ by family: v2 answers `{responseCode: 0, result}`, v3 answers `{code: 0, data}`
 * — `unwrap` handles both.
 *
 * V1 SIMPLIFICATIONS (deliberate, vs clientV2's full TransitionButtonMixin):
 *  - Transitions carrying forms (`formId`/`dialogType === 2`) execute with empty `data`; if the
 *    backend's form rules reject that, the error surfaces verbatim as a toast.
 *  - The confirmation-dialog step (`v2/statetransition/confirmationDialogs`) is not called.
 *  - `commentRequired` is collected via a plain prompt upstream and travels as
 *    `data.transitionCommentData = {body, bodyHTML}` (the shape clientV2 sends).
 */

export interface TransitionOption {
  id: number;
  name: string;
  commentRequired?: boolean;
  formId?: number | null;
  dialogType?: number | null;
}

export interface FlowState {
  /** Display name of the record's current state (null when the flow isn't enabled/resolvable). */
  currentStateName: string | null;
  transitions: TransitionOption[];
}

/** `moduleState`/`approvalStatus`/transition-state objects -> a printable label (never render the raw object). */
export function stateName(state: any): string | null {
  if (state == null) return null;
  if (typeof state === 'string') return state.trim() || null;
  const n = state.displayName ?? state.status ?? state.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Heuristic for "awaiting approval" state labels — clientV2 resolves this server-side; we approximate by name. */
export function isPendingApprovalName(name: string | null | undefined): boolean {
  return !!name && /pending|requested|waiting/i.test(name);
}

export function findCancelTransition(transitions: TransitionOption[]): TransitionOption | null {
  return transitions.find((t) => /cancel/i.test(t.name)) ?? null;
}

/**
 * An ASSIGN-ish transition (never a vacate/unassign one). Assign and re-assign are RECORD WRITES
 * in this app (requested): the picker patches the desk's assignee field and that is the whole
 * action — no transition call. This predicate exists so those transitions can be kept off the
 * button bar and, where one is the only way back into the picker (Re-Assign), open it without
 * firing. VACATE is the opposite: it goes straight to the transition API.
 */
export function isAssignTransition(t: TransitionOption): boolean {
  return /assign/i.test(t.name) && !/vacat|un-?assign|de-?assign|release/i.test(t.name);
}

/**
 * Run the record's own assign transition IF its current state still offers one — called AFTER the
 * assignee has actually been written (picker or drag-and-drop), never on a button click.
 *
 * Writing the field alone does not move the record's STATE: a desk stayed "Yet to Assign" with a
 * holder on it, so the flow kept offering the unassigned actions and Vacate never appeared
 * (reported). Returns the transition's name, or null when the state offers none — already
 * occupied, no stateflow on the module, or local mode.
 */
export async function runAssignTransition(moduleName: string, recordId: number): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  const flow = await fetchAvailableStates(moduleName, recordId).catch(() => null);
  const t = (flow?.transitions ?? []).find(isAssignTransition);
  if (!t) return null;
  await executeStateTransition(moduleName, recordId, t.id);
  return t.name;
}

/**
 * A VACATE-ish transition — the mirror of isAssignTransition. Orgs name it differently (Vacate,
 * Unassign, Release, Check Out, Free Desk), and matching only /vacat|unassign/ left the assignee
 * on screen after any other spelling (reported: transition done, details not updated).
 */
export function isVacateTransition(t: TransitionOption): boolean {
  return /vacat|un-?assign|de-?assign|release|check\s*out|free/i.test(t.name);
}

function assertConfigured(): void {
  if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured');
}

/** v2 bodies nest under `result` (responseCode), v3 under `data` (code) — accept either. */
function unwrap(body: any): any {
  if (body == null) return null;
  if (body.responseCode !== undefined && body.responseCode !== 0) throw new Error(body.message || `responseCode ${body.responseCode}`);
  if (body.code !== undefined && body.code !== 0) throw new Error(body.message || `code ${body.code}`);
  return body.result ?? body.data ?? body;
}

function toTransitionOptions(states: any[]): TransitionOption[] {
  return (states ?? [])
    .filter((s) => s && !s.isOffline && typeof s.id === 'number')
    .map((s) => ({
      id: s.id,
      name: String(s.name ?? s.displayName ?? `Transition ${s.id}`),
      commentRequired: !!s.commentRequired,
      formId: s.formId ?? null,
      dialogType: s.dialogType ?? null,
    }));
}

/** Available state transitions for a record — empty transitions when the module/record has no stateflow. */
export async function fetchAvailableStates(moduleName: string, recordId: number): Promise<FlowState> {
  assertConfigured();
  const body = await customGet('v2/statetransition/getAvailableState', { moduleName, id: recordId });
  const res = unwrap(body);
  return { currentStateName: stateName(res?.currentState), transitions: toTransitionOptions(res?.states) };
}

/**
 * Executes one state transition. Primary path is the real client's PATCH; in connected mode,
 * where the SDK bridge's PATCH support is unverified, a thrown transport error falls back to a
 * plain module update carrying `stateTransitionId` — the exact payload clientV2's own permalink
 * transition page sends via updateRecord, so the server-side behavior is proven.
 */
export async function executeStateTransition(moduleName: string, recordId: number, transitionId: number, data?: Record<string, unknown>): Promise<void> {
  assertConfigured();
  const payload = { id: recordId, stateTransitionId: transitionId, data: data ?? {} };
  try {
    const body = await customPatch(`v3/action/${moduleName}/${recordId}/transition`, payload);
    unwrap(body);
    return;
  } catch (err) {
    if (!isConnectedApp) throw err;
    // eslint-disable-next-line no-console
    console.warn(`[stateflow] PATCH transition failed in connected mode — falling back to updateRecord`, err);
  }
  const res = await facilioApi.updateRecord(moduleName, { id: recordId, data: data ?? {}, stateTransitionId: transitionId } as any);
  if (res.error) throw new Error(res.error.message || `transition failed (code ${res.error.code ?? '?'})`);
}

/** Available approval actions (Approve/Reject/Cancel/...) — empty when the record isn't under an approval flow. */
export async function fetchApprovalTransitions(moduleName: string, recordId: number): Promise<FlowState> {
  assertConfigured();
  const body = await customPost('v2/approval/availableTransitions', { moduleName, id: recordId });
  const res = unwrap(body);
  return { currentStateName: stateName(res?.currentState), transitions: toTransitionOptions(res?.states) };
}

/** Executes one approval action. No non-PATCH fallback exists in clientV2 — a transport failure surfaces to the caller. */
export async function executeApprovalTransition(moduleName: string, recordId: number, approvalTransitionId: number, data?: Record<string, unknown>): Promise<void> {
  assertConfigured();
  const body = await customPatch(`v3/approval/action/${moduleName}/${recordId}/approval`, {
    id: recordId,
    approvalTransitionId,
    data: data ?? {},
  });
  unwrap(body);
}
