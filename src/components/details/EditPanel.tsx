import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { unitById } from '../../state/selectors';
import { polyAreaM2 } from '../../lib/geometry';
import { BUILTIN_MARKERS, DESK_TYPES, floorImageKey, TYPE_META } from '../../lib/types';
import type { EditTool, MarkerDef } from '../../lib/types';
import { MARKER_ICONS } from '../canvas/markerIcons';
import { Button } from '../primitives/Button';
import { Picklist } from '../fds/Picklist';
import { Select } from '../primitives/Select';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { createMarkerType, fetchMarkerIconUrl, fetchUnitModuleState, getAllModules, getCustomMarkerTypes, uploadMarkerIcon } from '../../lib/facilioApiDataSource';
import card from './Card.module.css';
import styles from './EditPanel.module.css';

const TOOL_ICON: Record<string, ReactNode> = {
  select: <path d="M3 3l7 18 2.5-7.5L20 11z" />,
  room: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />,
  workstation: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  locker: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  parking: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 16V8h3.5a2.5 2.5 0 0 1 0 5H9.5" />
    </>
  ),
  asset: (
    <>
      <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </>
  ),
  amenity: (
    <>
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  calibrate: (
    <>
      <path d="M21.3 8.7l-6-6L2.7 15.3l6 6z" />
      <path d="M14 6l1.5 1.5M11 9l1.5 1.5M8 12l1.5 1.5" />
    </>
  ),
};

function ToolGlyph({ tool, size = 16 }: { tool: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {TOOL_ICON[tool] ?? TOOL_ICON.select}
    </svg>
  );
}

const ADD_TOOLS: { id: 'workstation' | 'locker' | 'parking'; label: string; color: string }[] = [
  { id: 'workstation', label: 'Desk', color: '#0059D6' },
  { id: 'locker', label: 'Locker', color: '#3C229D' },
  { id: 'parking', label: 'Parking', color: '#1E9E5A' },
];

const NM_SWATCHES = ['#0059D6', '#3C229D', '#29A01E', '#B61919', '#C2761A', '#0EA5A5', '#607796'];

/** Off-screen colored chip used as the HTML5 drag image for library markers / add tools. */
function makeChipDragImage(e: ReactDragEvent, color: string, round: boolean, inner: string) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:-1000px;left:-1000px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;' +
    `border-radius:${round ? '999px' : '8px'};background:${color};color:#fff;font:700 11px/1 sans-serif;box-shadow:0 4px 12px rgba(40,54,72,0.35);`;
  el.innerHTML = inner;
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 16, 16);
  setTimeout(() => el.remove(), 0);
}

function MarkerChipContent({ def }: { def: MarkerDef }) {
  if (def.img) return <img src={def.img} alt="" draggable={false} />;
  if (def.icon) return MARKER_ICONS[def.icon];
  return <span style={{ font: '700 9px/1 var(--font-sans)' }}>{(def.text ?? '?').slice(0, 2)}</span>;
}

export function EditPanel() {
  const { state } = useFloorplan();
  const [tab, setTab] = useState<'tools' | 'markers'>('tools');
  return (
    <div className={styles.stack}>
      <div className={styles.tabs}>
        <button className={[styles.tab, tab === 'tools' ? styles.tabActive : ''].join(' ')} onClick={() => setTab('tools')}>
          Tools
        </button>
        <button className={[styles.tab, tab === 'markers' ? styles.tabActive : ''].join(' ')} onClick={() => setTab('markers')}>
          Markers
        </button>
      </div>
      <div className={styles.scrollArea}>
        {tab === 'tools' ? <ToolsTab /> : <MarkersTab />}
        {state.tool === 'calibrate' && state.calib.length > 0 && <CalibrationCard />}
        {tab === 'tools' && state.tool === 'asset' && <AssetListCard />}
        <Inspector />
      </div>
    </div>
  );
}

function ToolsTab() {
  const { state, actions } = useFloorplan();

  const armedDef = state.tool === 'amenity' ? [...BUILTIN_MARKERS, ...state.customMarkers].find((m) => m.id === state.markerKind) : undefined;
  const placingUnit = state.placingUnitId ? state.unplacedUnits.find((u) => u.id === state.placingUnitId) : undefined;

  let bannerTool: string = state.tool;
  let bannerName: string;
  let bannerHint: string;
  if (placingUnit) {
    bannerTool = placingUnit.type;
    bannerName = `Place “${placingUnit.label}”`;
    bannerHint = 'Click anywhere on the plan to place it. Esc cancels.';
  } else {
    const names: Record<EditTool, string> = {
      select: 'Select & move',
      room: 'Draw room',
      calibrate: 'Set scale',
      workstation: 'Place desks',
      locker: 'Place lockers',
      parking: 'Place parking',
      amenity: armedDef ? `Place ${armedDef.name.toLowerCase()} markers` : 'Place markers',
      asset: 'Place assets',
    };
    bannerName = names[state.tool];
    bannerHint = 'Click a unit to edit it · drag to move · Shift+drag to select many.';
    if (state.tool === 'room') bannerHint = 'Click corners on the plan; click the first point or press Enter to finish.';
    else if (state.tool === 'calibrate') bannerHint = 'Click two points a known distance apart to set scale.';
    else if (state.tool === 'asset') bannerHint = 'Drag an asset from the list below onto the plan.';
    else if (state.tool !== 'select') bannerHint = 'Click anywhere on the plan to drop one. Keep clicking to add more.';
  }

  const workTools: { id: EditTool; label: string; title: string }[] = [
    { id: 'select', label: 'Select', title: 'Select & move (V)' },
    { id: 'room', label: 'Room', title: 'Draw a room' },
    { id: 'calibrate', label: 'Scale', title: 'Calibrate scale' },
  ];

  const cadGroups = state.cadAnalyses[floorImageKey(state.floorId, state.planId)];

  return (
    <div className={card.card}>
      <div className={card.cardBody}>
        <div className={styles.banner}>
          <span className={styles.bannerIcon}>
            <ToolGlyph tool={bannerTool === 'select' ? 'select' : bannerTool} size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className={styles.bannerName}>{bannerName}</div>
            <div className={styles.bannerHint}>{bannerHint}</div>
          </div>
        </div>

        <div className={styles.sectionLabel}>Work with units</div>
        <div className={styles.workGrid}>
          {workTools.map((t) => (
            <button
              key={t.id}
              title={t.title}
              className={[styles.workBtn, state.tool === t.id && !state.placingUnitId ? styles.workBtnActive : ''].join(' ')}
              onClick={() => actions.setTool(t.id)}
            >
              <ToolGlyph tool={t.id} />
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.sectionLabel}>Add to plan</div>
        <div className={styles.addGrid}>
          {ADD_TOOLS.map((t) => {
            const on = state.tool === t.id && !state.placingUnitId;
            return (
              <button
                key={t.id}
                title="Drag onto the plan, or click to arm the tool"
                className={[styles.addBtn, on ? styles.addBtnActive : ''].join(' ')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-floorplan-addtool', t.id);
                  e.dataTransfer.effectAllowed = 'copy';
                  makeChipDragImage(
                    e,
                    t.color,
                    false,
                    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${
                      t.id === 'workstation'
                        ? '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'
                        : t.id === 'locker'
                          ? '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
                          : '<circle cx="12" cy="12" r="9"/><path d="M9.5 16V8h3.5a2.5 2.5 0 0 1 0 5H9.5"/>'
                    }</svg>`,
                  );
                }}
                onClick={() => actions.setTool(t.id)}
              >
                <span className={styles.addChip} style={{ background: on ? 'rgba(255,255,255,0.22)' : t.color }}>
                  <ToolGlyph tool={t.id} size={13} />
                </span>
                {t.label}
              </button>
            );
          })}
          <button
            title="Pick an asset from the list, then drag it onto the plan"
            className={[styles.addBtn, state.tool === 'asset' ? styles.addBtnActive : ''].join(' ')}
            onClick={() => actions.setTool('asset')}
          >
            <span className={styles.addChip} style={{ background: state.tool === 'asset' ? 'rgba(255,255,255,0.22)' : '#3C229D' }}>
              <ToolGlyph tool="asset" size={13} />
            </span>
            Asset
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <Button variant="secondary" fullWidth onClick={() => actions.setUploadOpen(true)}>
            Upload / replace floorplan image
          </Button>
          {!!cadGroups?.length && (
            <div style={{ marginTop: 8 }}>
              <Button variant="secondary" fullWidth onClick={() => actions.openAutoMap(cadGroups)}>
                Auto-map CAD units
              </Button>
              <p className={card.helper} style={{ marginTop: 6 }}>
                Re-runs the layer/block mapping from the uploaded CAD file. Mapping again adds new units — discard or delete the earlier batch
                first if you don't want duplicates.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkersTab() {
  const { state, actions } = useFloorplan();
  const [formOpen, setFormOpen] = useState(false);
  const [nmName, setNmName] = useState('');
  const [nmDescription, setNmDescription] = useState('');
  const [nmText, setNmText] = useState('');
  const [nmModuleId, setNmModuleId] = useState('');
  const [nmFile, setNmFile] = useState<File | null>(null);
  const [nmPreviewUrl, setNmPreviewUrl] = useState<string | null>(null);
  const [nmColor, setNmColor] = useState('#607796');
  const [saving, setSaving] = useState(false);
  const [moduleOptions, setModuleOptions] = useState<{ value: string; label: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The org's real module list, for the "Select Module" dropdown (markertype.recordModuleId).
  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    getAllModules().then((modules) => {
      setModuleOptions(modules.map((m) => ({ value: String(m.id), label: m.displayName })));
    });
  }, []);

  // Real custom marker types (markertype module) fetched once when configured — built-ins keep
  // their own hardcoded icons; this only replaces the previously local-only custom-markers list.
  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    let cancelled = false;
    getCustomMarkerTypes()
      .then(async (defs) => {
        const resolved = await Promise.all(
          defs.map(async (d) => (d.fileId ? { ...d, img: (await fetchMarkerIconUrl(d.fileId).catch(() => null)) ?? undefined } : d))
        );
        if (!cancelled) actions.setCustomMarkers(resolved);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] custom marker types fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const defs = [...BUILTIN_MARKERS, ...state.customMarkers];

  function pickFile(file: File) {
    setNmFile(file);
    setNmPreviewUrl(URL.createObjectURL(file));
  }

  async function saveNewMarker() {
    const name = nmName.trim();
    if (!name) {
      actions.showToast('“Marker name” is required');
      return;
    }
    if (!nmModuleId) {
      actions.showToast('“Module” is required');
      return;
    }
    if (!nmFile) {
      actions.showToast('“Marker Icon” is required');
      return;
    }
    const text = (nmText.trim() || name).slice(0, 2).toUpperCase();

    if (isFacilioApiConfigured) {
      setSaving(true);
      try {
        const fileId = await uploadMarkerIcon(nmFile);
        const created = await createMarkerType({ name, description: nmDescription.trim(), fileId, recordModuleId: Number(nmModuleId) });
        const img = (await fetchMarkerIconUrl(fileId).catch(() => null)) ?? nmPreviewUrl ?? undefined;
        actions.addCustomMarker({ id: created.id, name, color: nmColor, text, img, fileId });
        actions.setMarkerKind(created.id);
      } catch (err) {
        actions.showToast(`Couldn't save the marker: ${(err as Error).message || 'unknown error'}`);
        setSaving(false);
        return;
      }
      setSaving(false);
    } else {
      // Local/dev — no real backend to upload to; use the client-side preview directly.
      const id = 'm' + Date.now();
      actions.addCustomMarker({ id, name, color: nmColor, text, img: nmPreviewUrl ?? undefined });
      actions.setMarkerKind(id);
    }

    setFormOpen(false);
    setNmName('');
    setNmDescription('');
    setNmText('');
    setNmModuleId('');
    setNmFile(null);
    setNmPreviewUrl(null);
    setNmColor('#607796');
  }

  return (
    <div className={card.card}>
      <div className={card.cardBody}>
        <p className={styles.markerHint}>
          Drag a marker onto the plan, or click one and then click the plan. Markers are facility points like stairs, restrooms or fire
          exits.
        </p>
        <div className={styles.grid}>
          {defs.map((def) => {
            const on = state.tool === 'amenity' && state.markerKind === def.id;
            return (
              <button
                key={def.id}
                title="Drag onto the plan, or click to arm"
                className={[styles.markerBtn, on ? styles.markerBtnActive : ''].join(' ')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-floorplan-marker', def.id);
                  e.dataTransfer.effectAllowed = 'copy';
                  makeChipDragImage(e, def.color, true, (def.text ?? def.name.slice(0, 1)).slice(0, 2).toUpperCase());
                }}
                onClick={() => actions.setMarkerKind(def.id)}
              >
                <span className={styles.markerChip} style={{ background: def.color }}>
                  <MarkerChipContent def={def} />
                </span>
                <span className={styles.markerName}>{def.name}</span>
              </button>
            );
          })}
        </div>

        {formOpen ? (
          <div className={styles.newMarkerForm}>
            <div className={styles.newMarkerTitle}>New marker</div>
            <label className={card.label}>Marker name</label>
            <input className={card.input} placeholder="Enter the name" value={nmName} onChange={(e) => setNmName(e.target.value)} />
            <label className={card.label} style={{ marginTop: 10 }}>
              Description
            </label>
            <textarea
              className={card.input}
              style={{ height: 60, padding: '8px 10px', resize: 'vertical' }}
              placeholder="Description"
              value={nmDescription}
              onChange={(e) => setNmDescription(e.target.value)}
            />
            <label className={card.label} style={{ marginTop: 10 }}>
              Module
            </label>
            <Select
              value={nmModuleId || null}
              options={moduleOptions}
              onChange={setNmModuleId}
              placeholder={moduleOptions.length ? 'Select Module' : 'Loading modules…'}
              fullWidth
              disabled={moduleOptions.length === 0}
              aria-label="Module"
            />
            <label className={card.label} style={{ marginTop: 10 }}>
              Short label (1–2 chars, shown until the icon loads)
            </label>
            <input className={card.input} placeholder="e.g. WC" maxLength={2} value={nmText} onChange={(e) => setNmText(e.target.value)} />
            <label className={card.label} style={{ marginTop: 10 }}>
              Marker Icon
            </label>
            <div
              style={{
                marginTop: 4,
                border: '1px dashed var(--ink-300)',
                borderRadius: 8,
                padding: '16px 12px',
                textAlign: 'center',
                cursor: 'pointer',
                background: 'var(--ink-025, #fafafa)',
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) pickFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              {nmPreviewUrl ? (
                <img src={nmPreviewUrl} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: '50%' }} />
              ) : (
                <div style={{ font: '400 12px/1.4 var(--font-sans)', color: 'var(--ink-500)' }}>Drag and drop your file(s) or click to browse</div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickFile(file);
                }}
              />
            </div>
            <div className={styles.swatches}>
              {NM_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  title={hex}
                  className={styles.swatch}
                  style={{ background: hex, boxShadow: nmColor === hex ? `0 0 0 2px #fff, 0 0 0 4px ${hex}` : 'none' }}
                  onClick={() => setNmColor(hex)}
                />
              ))}
            </div>
            <div className={styles.formRow}>
              <Button variant="secondary" fullWidth onClick={() => setFormOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" fullWidth disabled={saving} onClick={saveNewMarker}>
                {saving ? 'Saving…' : 'Add marker'}
              </Button>
            </div>
          </div>
        ) : (
          <button className={styles.newMarkerBtn} onClick={() => setFormOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New marker
          </button>
        )}
      </div>
    </div>
  );
}

function Inspector() {
  const { state, actions } = useFloorplan();
  const sel = unitById(state, state.selected);
  const multi = state.multiSelected;

  // The real backend record's own status field, fetched read-only (no record is ever created
  // just to check this — a unit that's never been assigned/vacated/booked has no real record
  // yet, and fetchUnitModuleState returns null rather than creating one).
  const [moduleState, setModuleState] = useState<string | null>(null);
  useEffect(() => {
    setModuleState(null);
    if (!sel || !isFacilioApiConfigured) return;
    let cancelled = false;
    fetchUnitModuleState(sel).then((v) => {
      if (!cancelled) setModuleState(v);
    });
    return () => {
      cancelled = true;
    };
  }, [sel?.id]);

  if (multi.length > 1) {
    return (
      <div className={card.card}>
        <div className={card.cardBody}>
          <div className={styles.inspectorHead}>
            <span className={styles.inspectorCount}>{multi.length} selected</span>
            <button className={styles.inspectorClose} title="Deselect" onClick={() => actions.setMultiSelected([])}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <Button variant="danger" fullWidth onClick={() => actions.deleteUnits(multi)}>
            Delete {multi.length}
          </Button>
          <p className={styles.inspectorNote}>Deleting keeps the records — desks, lockers and stalls move to “Available to place”.</p>
        </div>
      </div>
    );
  }

  if (!sel) return null;
  return (
    <div className={card.card}>
      <div className={card.cardBody}>
        <div className={styles.inspectorHead}>
          <span className={styles.inspectorCount}>{sel.label}</span>
          <button className={styles.inspectorClose} title="Deselect" onClick={() => actions.selectUnit(null)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <label className={card.label}>Label</label>
        <input className={card.input} value={sel.label} onChange={(e) => actions.updateUnit(sel.id, { label: e.target.value })} />
        {sel.type === 'workstation' && (
          <>
            <label className={card.label} style={{ marginTop: 10 }}>
              Seat type
            </label>
            <input className={card.input} value={sel.secondary ?? ''} onChange={(e) => actions.updateUnit(sel.id, { secondary: e.target.value })} />
            {/* Real deskType semantics (Context/Workplace_spaceModules.md): ASSIGNED desks are
                assignment-only; HOT/HOTEL desks are booking-only. Changing this immediately
                regates the assign/book flows for this marker. FDS Picklist (Canvas-2.dc.html
                design) replaces the former raw <select>. */}
            <div style={{ marginTop: 10 }}>
              <Picklist
                label="Desk type"
                value={sel.deskType ?? 'ASSIGNED'}
                onChange={(v) => actions.updateUnit(sel.id, { deskType: v })}
                options={DESK_TYPES.map((t) => ({
                  value: t.id,
                  label: t.name,
                  description: t.id === 'ASSIGNED' ? 'Assignable, not bookable' : 'Bookable, not assignable',
                }))}
                aria-label="Desk type"
              />
            </div>
          </>
        )}
        <div className={card.statRow}>
          <span className={card.statLabel}>Type</span>
          <span className={card.statValue}>{TYPE_META[sel.type].name}</span>
        </div>
        {moduleState && (
          <div className={card.statRow}>
            <span className={card.statLabel}>Status</span>
            <span className={card.statValue}>{moduleState}</span>
          </div>
        )}
        {sel.type === 'room' && (
          <div className={card.statRow}>
            <span className={card.statLabel}>Is Reservable</span>
            <span className={card.statValue}>{sel.isReservable === false ? 'No — assignable' : 'Yes — bookable'}</span>
          </div>
        )}
        {sel.room && (
          <div className={card.statRow}>
            <span className={card.statLabel}>Room</span>
            <span className={card.statValue}>{sel.room}</span>
          </div>
        )}
        {sel.geom.kind === 'poly' && (
          <div className={card.statRow}>
            <span className={card.statLabel}>Area</span>
            <span className={card.statValue}>
              {(() => {
                const a = polyAreaM2(sel.geom.pts, state.pxPerMeter);
                return a != null ? `${a.toFixed(1)} m²` : 'Calibrate to see area';
              })()}
            </span>
          </div>
        )}
        <Button variant="danger" fullWidth style={{ marginTop: 10 }} onClick={() => actions.deleteUnit(sel.id)}>
          Delete
        </Button>
        {sel.type !== 'room' && sel.type !== 'amenity' && (
          <p className={styles.inspectorNote}>Deleting keeps the record — it moves to “Available to place” so you can re-position it later.</p>
        )}
      </div>
    </div>
  );
}

function CalibrationCard() {
  const { state, actions } = useFloorplan();
  const calibReady = state.calib.length === 2;
  return (
    <div className={card.card}>
      <div className={card.cardHead}>
        <h3 className={card.cardTitle}>Calibration</h3>
      </div>
      <div className={card.cardBody}>
        {!calibReady ? (
          <p className={card.helper}>Click two points on the plan a known real-world distance apart.</p>
        ) : (
          <div className={styles.calibRow}>
            <input
              className={card.input}
              type="number"
              min={0.1}
              step={0.1}
              placeholder="Distance in meters"
              value={state.calibLen}
              onChange={(e) => actions.setCalibLen(e.target.value)}
            />
            <Button variant="primary" onClick={actions.applyCalib} disabled={!(parseFloat(state.calibLen) > 0)}>
              Apply
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A one-off DOM node used as the HTML5 drag image while dragging an asset:
 * the actual asset marker (violet chip + white glyph) so the cursor carries
 * the marker, not the list row. Self-removes after the drag starts.
 */
function makeAssetDragImage(): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    width: '32px',
    height: '32px',
    borderRadius: '8px',
    background: '#6d5bd0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 12px rgba(40,54,72,0.35)',
  } as CSSStyleDeclaration);
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 0);
  return el;
}

function AssetListCard() {
  const { state } = useFloorplan();
  const [assetQuery, setAssetQuery] = useState('');
  const placedAssetIds = useMemo(() => new Set(state.units.filter((u) => u.assetId).map((u) => u.assetId)), [state.units]);
  const filteredAssets = useMemo(() => {
    const q = assetQuery.trim().toLowerCase();
    return state.assets.filter((a) => !q || a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q) || a.detail.toLowerCase().includes(q));
  }, [assetQuery, state.assets]);

  return (
    <div className={card.card}>
      <div className={card.cardHead}>
        <h3 className={card.cardTitle}>Assets</h3>
      </div>
      <div className={card.cardBody}>
        <input className={card.input} placeholder="Search assets" value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} />
        <p className={card.helper} style={{ margin: '8px 0 4px' }}>
          Drag an asset onto the plan to place it.
        </p>
        <div className={styles.assetList}>
          {filteredAssets.map((a) => {
            const placed = placedAssetIds.has(a.id);
            return (
              <div
                key={a.id}
                className={styles.assetRow}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-floorplan-asset', a.id);
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setDragImage(makeAssetDragImage(), 16, 16);
                }}
                title="Drag onto the floorplan to place"
              >
                <span className={styles.assetIcon}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" />
                    <path d="M12 13v8" />
                  </svg>
                </span>
                <span className={styles.assetText}>
                  <span className={styles.assetName}>{a.name}</span>
                  <span className={styles.assetDetail}>
                    {a.category} · {a.detail}
                  </span>
                </span>
                {placed && (
                  <span className={styles.assetPlaced} title="Already on this plan (drag to move)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                )}
              </div>
            );
          })}
          {filteredAssets.length === 0 && <p className={card.helper}>No assets match.</p>}
        </div>
      </div>
    </div>
  );
}
