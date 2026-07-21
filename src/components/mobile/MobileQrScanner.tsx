import { useEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { isBookable } from '../../state/selectors';
import type { Unit } from '../../lib/types';
import styles from './MobileQrScanner.module.css';

/**
 * Camera QR scanner for "walk up to a space, scan, book it". Decoding uses
 * the native BarcodeDetector (Chrome/Android — no bundled decoder); on
 * browsers without it (iOS Safari) the camera preview is skipped and the
 * manual code field, always shown, is the path. A decoded value is matched
 * against the floor's units and the booking form opens pre-filled with that
 * space.
 */

/** QR payloads vary (plain label, id, or a URL) — try the obvious shapes. */
function matchUnit(units: Unit[], raw: string): Unit | undefined {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '');
  let code = raw.trim();
  try {
    const url = new URL(code);
    code =
      url.searchParams.get('qr') ??
      url.searchParams.get('space') ??
      url.searchParams.get('unit') ??
      url.pathname.split('/').filter(Boolean).pop() ??
      code;
  } catch {
    /* not a URL — use as-is */
  }
  const target = norm(code);
  if (!target) return undefined;
  return (
    units.find((u) => norm(u.label) === target) ??
    units.find((u) => norm(u.id) === target) ??
    units.find((u) => norm(u.label).includes(target) || target.includes(norm(u.label)))
  );
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export function MobileQrScanner({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraState, setCameraState] = useState<'starting' | 'live' | 'unavailable'>('starting');
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  function handleCode(raw: string) {
    if (doneRef.current) return;
    const unit = matchUnit(state.units, raw);
    if (!unit) {
      setError(`No space matching “${raw.slice(0, 60)}” on this floor.`);
      return;
    }
    doneRef.current = true;
    if (isBookable(unit)) {
      // The ask: scanning opens the booking form with the scanned space set.
      actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end });
      actions.showToast(`Space scanned — ${unit.label}`);
    } else {
      // Not a bookable type (e.g. locker) — show its detail sheet instead.
      actions.setMobSel(unit.id);
      actions.showToast(`Space scanned — ${unit.label} isn't bookable; showing details`);
    }
    onClose();
  }

  useEffect(() => {
    // Camera scanning needs only getUserMedia: decode via the native
    // BarcodeDetector where it exists (Chrome/Android), otherwise through the
    // bundled jsQR decoder on downscaled canvas frames — BarcodeDetector is
    // missing on iOS Safari, Firefox, and most desktop Chrome builds, which
    // previously forced those onto manual code entry.
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('unavailable');
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraState('live');

        if ('BarcodeDetector' in window) {
          const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => BarcodeDetectorLike })
            .BarcodeDetector;
          const detector = new Detector({ formats: ['qr_code'] });
          timer = setInterval(() => {
            const video = videoRef.current;
            if (!video || video.readyState < 2) return;
            detector
              .detect(video)
              .then((codes) => {
                if (codes.length > 0 && codes[0].rawValue) handleCode(codes[0].rawValue);
              })
              .catch(() => {
                /* per-frame decode errors are normal */
              });
          }, 350);
        } else {
          const { default: jsQR } = await import('jsqr');
          if (cancelled) return;
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          timer = setInterval(() => {
            const video = videoRef.current;
            if (!video || !ctx || video.readyState < 2 || !video.videoWidth) return;
            // downscale to ~480px wide — plenty for QR, keeps decode cheap
            const scale = Math.min(1, 480 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) handleCode(code.data);
          }, 450);
        }
      } catch {
        if (!cancelled) setCameraState('unavailable');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.overlay}>
      <div className={styles.topRow}>
        <span className={styles.title}>Scan a space QR</span>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close scanner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {cameraState !== 'unavailable' ? (
        <div className={styles.videoWrap}>
          <video ref={videoRef} className={styles.video} muted playsInline />
          <div className={styles.reticle} />
          {cameraState === 'starting' && <div className={styles.videoHint}>Starting camera…</div>}
        </div>
      ) : (
        <div className={styles.noCamera}>
          Couldn't start the camera — it may be blocked (check the browser's camera permission for
          this site) or unavailable on this device. You can still enter the code printed under the
          QR below.
        </div>
      )}

      <form
        className={styles.manualRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (manualCode.trim()) handleCode(manualCode);
        }}
      >
        <input
          className={styles.manualInput}
          value={manualCode}
          placeholder="Or type the space code (e.g. WS-07)"
          onChange={(e) => {
            setManualCode(e.target.value);
            setError(null);
          }}
        />
        <button className={styles.manualGo} type="submit" disabled={!manualCode.trim()}>
          Find
        </button>
      </form>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
