import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { isCadFile } from '../../lib/cadPreview';
import { analyzeCadFile } from '../../lib/cadAnalyze';
import type { CadGroup } from '../../lib/cadAnalyze';
import { renderPdfToDataUrl } from '../../lib/pdfPreview';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { uploadFloorplanFile } from '../../lib/facilioApiDataSource';
import { measureImageDataUrl } from '../../lib/geoReference';
import styles from './FloorUploadModal.module.css';

const ACCEPT = '.png,.jpg,.jpeg,.pdf,.dwg,.dxf,image/png,image/jpeg,application/pdf';

export function FloorUploadModal() {
  const { state, actions } = useFloorplan();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  if (!state.uploadOpen) return null;

  async function handleFile(file: File) {
    setFileName(file.name);
    setStatus('working');
    setError(null);
    const cad = isCadFile(file.name);
    try {
      const isPlainImage = /\.(png|jpe?g)$/i.test(file.name);
      // previewUrl stays null when the browser can't render the file (a DWG the CAD engine
      // chokes on) — we then rely on Facilio's server-rendered image fetched by file id.
      let previewUrl: string | null = null;
      let cadGroups: CadGroup[] = [];
      let clientRenderFailed = false;
      if (cad) {
        // One document-open pass renders the snapshot AND extracts the drawing's mappable
        // structure. If the embedded CAD engine can't parse this DWG, DON'T abort — fall
        // through and let the server render it from the uploaded file id.
        try {
          const analysis = await analyzeCadFile(file);
          previewUrl = analysis.previewUrl;
          cadGroups = analysis.groups;
        } catch (cadErr) {
          clientRenderFailed = true;
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Browser CAD render failed; will try the server-rendered image', cadErr);
        }
      } else if (/\.pdf$/i.test(file.name)) {
        previewUrl = await renderPdfToDataUrl(file);
      } else if (isPlainImage) {
        previewUrl = await fileToDataUrl(file);
      } else {
        throw new Error('Unsupported file type');
      }

      let uploadedFileId: number | null = null;
      let attachedToFloorPlan = false;
      let serverImageUsed = false;
      if (isFacilioApiConfigured) {
        try {
          // Measured off the rendered preview when we have one (sizes the synthetic
          // geo-reference quad). No local render (CAD failed) → skip; the server sizes it.
          const dimensions = previewUrl ? await measureImageDataUrl(previewUrl).catch(() => undefined) : undefined;
          const uploaded = await uploadFloorplanFile(state.floorId, state.planId, file, dimensions);
          uploadedFileId = uploaded.fileId;
          attachedToFloorPlan = uploaded.attachedToFloorPlan;
          // Plain image: use the round-tripped original (proves the real round-trip).
          if (isPlainImage) previewUrl = uploaded.previewUrl;
          // No browser render (or CAD that failed) → use Facilio's server-RENDERED image by id.
          if (!previewUrl && uploaded.serverImageUrl) {
            previewUrl = uploaded.serverImageUrl;
            serverImageUsed = true;
          }
          if (!uploaded.attachedToFloorPlan) {
            // eslint-disable-next-line no-console
            console.warn('[FloorUploadModal] Uploaded to Facilio but could not attach to this floor\'s indoorfloorplan record:', uploaded.attachError);
          }
        } catch (uploadErr) {
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Facilio upload failed', uploadErr);
        }
      }

      // Nothing renderable and nothing stored → the only true failure. (A stored-but-not-
      // renderable file is reported below, not thrown, so the upload isn't lost.)
      if (!previewUrl && uploadedFileId == null) {
        throw new Error(cad ? 'cad-render-failed' : 'Could not read this file.');
      }

      if (previewUrl) actions.setFloorImage(state.floorId, state.planId, previewUrl);
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
      // A stored-but-unpreviewable CAD file: keep the modal's error visible so the user knows
      // it's saved-but-not-shown, but don't discard the upload.
      if (!previewUrl && uploadedFileId != null) {
        setStatus('error');
        setError(`Stored to Facilio (file #${uploadedFileId}), but it couldn't be rendered to an image here — open it in AutoCAD.`);
        return;
      }
      actions.setUploadOpen(false);
      setStatus('idle');
      if (cad) actions.storeCadAnalysis(state.floorId, state.planId, cadGroups);
      if (cadGroups.length > 0) {
        actions.openAutoMap(cadGroups);
      } else if (cad && !clientRenderFailed) {
        actions.showToast(`Floorplan updated from ${file.name} — no mappable CAD metadata found`);
      }
    } catch (err) {
      setStatus('error');
      const msg = (err as Error).message;
      setError(cad || msg === 'cad-render-failed' ? 'Could not render this CAD file in the browser, and the server has no image for it. You can still store it and view it in AutoCAD.' : msg || 'Could not read this file.');
    }
  }

  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <Modal onClose={() => actions.setUploadOpen(false)} width={460}>
      <ModalHeader title="Upload floorplan" subtitle="PNG, JPG, PDF, DWG, or DXF" onClose={() => actions.setUploadOpen(false)} />
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
          <div className={styles.dzSub}>Supports .png .jpg .pdf .dwg .dxf</div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className={styles.hiddenInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
        {status === 'working' && <p className={styles.status}>Rendering {fileName}…</p>}
        {status === 'error' && <p className={styles.error}>{error}</p>}
        <p className={styles.note}>
          DWG/DXF files render in your browser via an embedded CAD engine. If the browser can't render one, it's uploaded to Facilio and shown
          from the server-rendered image (by file id) instead.
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
