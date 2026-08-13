import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { isCadFile, isCadTimeoutError } from '../../lib/cadPreview';
import { analyzeCadFile } from '../../lib/cadAnalyze';
import type { CadGroup } from '../../lib/cadAnalyze';
import { renderPdfToDataUrl } from '../../lib/pdfPreview';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { updateFloorplanGeometry, uploadFloorplanFile, type FloorplanFileUploadResult } from '../../lib/facilioApiDataSource';
import { measureImageDataUrl } from '../../lib/geoReference';
import styles from './FloorUploadModal.module.css';

const ACCEPT = '.png,.jpg,.jpeg,.svg,.pdf,.dwg,.dxf,image/png,image/jpeg,image/svg+xml,application/pdf';

/**
 * SVGs without width/height attributes measure as 0×0 (or a browser default), and a broken raster
 * can measure tiny — anything implausible counts as UNMEASURED rather than sizing a geo-reference
 * quad from it.
 */
function plausible(size: { width: number; height: number } | undefined): size is { width: number; height: number } {
  return !!size && size.width > 10 && size.height > 10;
}

export function FloorUploadModal() {
  const { state, actions } = useFloorplan();
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * In-flight guard. Dropping a second file while the first upload was still running let BOTH run:
   * whichever finished last won the plan record and the local image, so the file the user dropped
   * first could end up being the one that stuck.
   */
  const busyRef = useRef(false);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [phase, setPhase] = useState<'uploading' | 'rendering'>('uploading');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // Reset between opens — status/error used to persist, so re-opening after a failure showed the
  // OLD error over a fresh dropzone. An upload still running from a previous open keeps its state.
  useEffect(() => {
    if (!state.uploadOpen || busyRef.current) return;
    setStatus('idle');
    setError(null);
    setFileName(null);
  }, [state.uploadOpen]);

  if (!state.uploadOpen) return null;

  /**
   * UPLOAD FIRST, RENDER SECOND (requested order): (1) the file goes to Facilio, (2-3) the
   * `indoorfloorplan` record and the floor's `indoorFloorPlanId` are written, (4) the plan record is
   * read back as the source of truth — all four without touching the CAD/PDF engines — and only
   * THEN (5) the drawing is rendered, measured, analysed and auto-mapped.
   *
   * This order IS the fix: the CAD analysis used to run first, and for a DWG whose parser never
   * settles the upload request was never sent at all — no error, nothing in the network tab, the
   * file simply never left the browser. Now a CAD file that can't be read still reaches the org,
   * and the render is bounded by a timeout (see CAD_TIMEOUT_MS) instead of hanging.
   */
  async function handleFile(file: File) {
    if (busyRef.current) {
      actions.showToast('Still working on the previous file — wait for it to finish', { variant: 'warning' });
      return;
    }
    const cad = isCadFile(file.name);
    const isSvg = /\.svg$/i.test(file.name);
    const isPlainImage = /\.(png|jpe?g|svg)$/i.test(file.name);
    const isPdf = /\.pdf$/i.test(file.name);
    if (!cad && !isPlainImage && !isPdf) {
      setStatus('error');
      setError('Unsupported file type');
      return;
    }

    busyRef.current = true;
    setFileName(file.name);
    setPhase(isFacilioApiConfigured ? 'uploading' : 'rendering');
    setStatus('working');
    setError(null);
    // Declared OUTSIDE the try so the catch can report what actually happened. Kept inside, the
    // catch could only guess, and it guessed "CAD render failed" for every error a CAD file hit —
    // including an upload that never reached Facilio.
    let uploadedFileId: number | null = null;
    let uploadFailedMsg: string | null = null;
    try {
      // A plain raster's size is readable with a FileReader + <img> — no parser that can stall — so
      // it still rides along with the create and the record gets its exact quad first time.
      let previewUrl: string | null = null;
      let dimensions: { width: number; height: number } | undefined;
      if (isPlainImage) {
        previewUrl = await fileToDataUrl(file).catch(() => null);
        const measured = previewUrl ? await measureImageDataUrl(previewUrl).catch(() => undefined) : undefined;
        if (plausible(measured)) dimensions = measured;
      }

      // ---- STEPS 1-4: file → plan record → floor link → read-back ----
      let upload: FloorplanFileUploadResult | null = null;
      if (isFacilioApiConfigured) {
        try {
          upload = await uploadFloorplanFile(state.floorId, state.planId, file, dimensions);
        } catch (uploadErr) {
          // The backend never received the file. A local preview may still render below, but this
          // must NOT read as a successful "floorplan updated" — see uploadFailedMsg use.
          uploadFailedMsg = (uploadErr as Error).message || 'upload failed';
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Facilio upload failed', uploadErr);
        }
      }
      uploadedFileId = upload?.fileId ?? null;
      const attachedToFloorPlan = upload?.attachedToFloorPlan ?? false;
      if (upload && !upload.attachedToFloorPlan) {
        // eslint-disable-next-line no-console
        console.warn("[FloorUploadModal] Uploaded to Facilio but could not attach to this floor's indoorfloorplan record:", upload.attachError);
      } else if (upload) {
        // A create just changed which plan types this floor has — refresh the switcher.
        void actions.refreshPlanTypes();
      }

      // ---- STEP 5: render the preview, measure it, analyse the CAD ----
      setPhase('rendering');
      let cadGroups: CadGroup[] = [];
      let clientRenderFailed = false;
      let cadTimedOut = false;
      if (cad) {
        // One document-open pass renders the snapshot AND extracts the drawing's mappable
        // structure. A CAD engine that can't read this file is NOT fatal any more — the file is
        // already stored; fall through to Facilio's server-rendered image.
        try {
          const analysis = await analyzeCadFile(file);
          previewUrl = analysis.previewUrl;
          cadGroups = analysis.groups;
        } catch (cadErr) {
          clientRenderFailed = true;
          cadTimedOut = isCadTimeoutError(cadErr);
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Browser CAD render failed; will try the server-rendered image', cadErr);
        }
      } else if (isPdf) {
        try {
          previewUrl = await renderPdfToDataUrl(file);
        } catch (pdfErr) {
          clientRenderFailed = true;
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Browser PDF render failed; will try the server-rendered image', pdfErr);
        }
      }
      // Plain raster: use the round-tripped original (proves the real round-trip). SVG keeps the
      // LOCAL data URL — a round-tripped blob only renders as SVG when its MIME survived the trip,
      // and the local read is guaranteed correct either way.
      if (upload && isPlainImage && !isSvg) previewUrl = upload.previewUrl;
      // Nothing the browser could draw → use Facilio's server-RENDERED image by file id.
      let serverImageUsed = false;
      if (!previewUrl && upload?.serverImageUrl) {
        previewUrl = upload.serverImageUrl;
        serverImageUsed = true;
      }

      // The plan record already carries a geo-reference quad (measured above, or the default one
      // seeded at create time). Now that a real raster exists, refine it to that raster's true
      // aspect — skipped server-side when it already matches, so this is usually a no-op read.
      if (upload?.indoorFloorPlanId && upload.attachedToFloorPlan && !dimensions && previewUrl) {
        const measured = await measureImageDataUrl(previewUrl).catch(() => undefined);
        if (plausible(measured)) {
          const result = await updateFloorplanGeometry(upload.indoorFloorPlanId, measured).catch(() => 'failed' as const);
          if (result === 'failed') {
            // Not fatal: the record still has the default quad, so markers remain positionable —
            // they're just referenced against a frame of a different shape.
            // eslint-disable-next-line no-console
            console.warn(`[FloorUploadModal] couldn't refine the plan geometry to ${measured.width}×${measured.height}`);
          }
        }
      }

      // Nothing renderable and nothing stored → the only true failure. (A stored-but-not-
      // renderable file is reported below, not thrown, so the upload isn't lost.)
      //
      // NAME THE REAL CAUSE. When the upload failed, THAT is why there is nothing to show — the
      // render is a side issue. This used to throw straight past the upload-failure branch below,
      // so a rejected upload was reported as "could not render this CAD file... you can still store
      // it", which blamed the wrong step and promised a file the org never received.
      if (!previewUrl && uploadedFileId == null) {
        if (uploadFailedMsg) {
          setStatus('error');
          // The message from the upload layer is already a complete, actionable sentence (it names
          // the file, the size and what to do) — wrapping it in more prose just buried it.
          setError(uploadFailedMsg);
          actions.showToast('Floorplan not uploaded', { variant: 'error', description: uploadFailedMsg });
          return; // keep the modal open for a retry
        }
        throw new Error(cad ? 'cad-render-failed' : 'Could not read this file.');
      }

      // Only mirror the image into the local cache when the org actually has it (attach
      // succeeded, or pure local mode where local IS the store) — caching a failed upload's
      // preview would show THIS device a plan no other device/user sees.
      const persistLocal = !isFacilioApiConfigured || attachedToFloorPlan;
      if (previewUrl) actions.setFloorImage(state.floorId, state.planId, previewUrl, { persistLocal });

      // The backend upload FAILED but a local render exists: show it (better than nothing), but
      // say so honestly — the old flow toasted "Floorplan updated" and closed, so the user only
      // discovered the plan was never really replaced on the next reload/other device.
      if (isFacilioApiConfigured && uploadFailedMsg && uploadedFileId == null) {
        setStatus('error');
        setError(`Upload to Facilio failed: ${uploadFailedMsg}. The image below is shown on THIS device only — retry to actually replace the floorplan.`);
        actions.showToast('Floorplan NOT uploaded — shown locally only', { variant: 'error', description: uploadFailedMsg });
        return; // keep the modal open for a retry
      }

      actions.showToast(
        uploadedFileId
          ? serverImageUsed
            ? `Rendered on the server from file #${uploadedFileId}`
            : previewUrl
              ? attachedToFloorPlan
                ? `Floorplan uploaded to Facilio (file #${uploadedFileId})`
                : `Uploaded to Facilio (file #${uploadedFileId}) — couldn't link it to this floor's plan record`
              : `Stored to Facilio (file #${uploadedFileId}) — can't preview it here; view it in AutoCAD`
          : `Floorplan updated from ${file.name}`
      );
      // The write reported success but the read-back disagreed — surface it instead of letting the
      // next save discover it.
      if (upload?.readBackWarning) {
        actions.showToast('Check this floorplan in Facilio', { variant: 'warning', description: upload.readBackWarning });
      }
      // A stored-but-unpreviewable CAD file: keep the modal's error visible so the user knows
      // it's saved-but-not-shown, but don't discard the upload.
      if (!previewUrl && uploadedFileId != null) {
        setStatus('error');
        setError(
          cadTimedOut
            ? `Stored to Facilio (file #${uploadedFileId}), but this CAD file couldn't be read here — the CAD engine never finished. Open it in AutoCAD, or upload a PDF/PNG of the plan.`
            : `Stored to Facilio (file #${uploadedFileId}), but it couldn't be rendered to an image here — open it in AutoCAD.`
        );
        return;
      }
      actions.setUploadOpen(false);
      setStatus('idle');
      // ALWAYS store (even an empty list): replacing a CAD plan with a PNG/PDF must clear the
      // stale analysis, or Edit › "Auto-map CAD units" keeps offering the OLD drawing's groups.
      actions.storeCadAnalysis(state.floorId, state.planId, cadGroups);
      if (cadGroups.length > 0) {
        actions.openAutoMap(cadGroups);
      } else if (cad && !clientRenderFailed) {
        actions.showToast(`Floorplan updated from ${file.name} — no mappable CAD metadata found`);
      }
    } catch (err) {
      setStatus('error');
      const msg = (err as Error).message;
      // Never claim the file is safe unless a file id came back. The old text ended "You can still
      // store it and view it in AutoCAD" on EVERY error a CAD file hit — including ones where the
      // upload had failed and nothing was stored at all.
      const stored = uploadedFileId != null;
      setError(
        cad || msg === 'cad-render-failed'
          ? stored
            ? `Stored to Facilio (file #${uploadedFileId}), but this CAD file couldn't be rendered — open it in AutoCAD, or upload a PDF/PNG export of the plan.`
            : "Could not render this CAD file in the browser, and Facilio has no image for it. Nothing was saved — try uploading a PDF or PNG export of the plan."
          : msg || 'Could not read this file.'
      );
    } finally {
      busyRef.current = false;
    }
  }

  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  return (
    <Modal onClose={() => actions.setUploadOpen(false)} width={460}>
      <ModalHeader title="Upload floorplan" subtitle="PNG, JPG, SVG, PDF, DWG, or DXF" onClose={() => actions.setUploadOpen(false)} />
      <div className={styles.body}>
        <div
          className={styles.dropzone}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5M12 3v12" />
          </svg>
          <div className={styles.dzText}>Drag a file here, or click to browse</div>
          <div className={styles.dzSub}>Supports .png .jpg .svg .pdf .dwg .dxf</div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className={styles.hiddenInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Clear the input's value or picking the SAME file again fires no change event —
              // after a failed attempt, the obvious retry (re-pick that file) did nothing at all.
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </div>
        {status === 'working' && <p className={styles.status}>{phase === 'uploading' ? `Uploading ${fileName}…` : `Rendering ${fileName}…`}</p>}
        {status === 'error' && <p className={styles.error}>{error}</p>}
        <p className={styles.note}>
          The file is uploaded to Facilio first, then rendered here. DWG/DXF render in your browser via an embedded CAD engine; if the browser
          can't render one, it's still stored and shown from the server-rendered image (by file id) instead.
        </p>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={() => actions.setUploadOpen(false)}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
