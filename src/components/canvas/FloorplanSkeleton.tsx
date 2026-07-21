import { useEffect, useState } from 'react';
import styles from './FloorplanSkeleton.module.css';

/**
 * Ported 1:1 from the "Floorplan Loader" design (.design-src/Floorplan
 * Loader.dc.html): a blueprint card whose walls draw in once (outer wall
 * first, interior walls staggered), door swings and furniture rise in and
 * settle into a gentle shimmer, a blue scan beam sweeps the card, and the
 * status line rotates through loading messages with pulsing dots. Per-element
 * timing rides CSS custom properties (--dur/--delay) since module-scoped
 * keyframes can't be referenced from inline animation shorthands.
 */
const MESSAGES = [
  'Loading floor plan',
  'Setting up your space',
  'Placing rooms and furniture',
  'Syncing live availability',
  'Almost ready',
];

/** interior wall segment: [d, dash, duration s, delay s] */
const WALLS: [string, number, number, number][] = [
  ['M160 40 V92', 200, 0.8, 0.5],
  ['M160 124 V272', 200, 0.95, 0.62],
  ['M278 40 V92', 200, 0.8, 0.58],
  ['M278 120 V196', 200, 0.8, 0.7],
  ['M278 224 V272', 200, 0.7, 0.8],
  ['M40 176 H96', 200, 0.8, 0.72],
  ['M128 176 H160', 120, 0.6, 0.84],
  ['M160 160 H205', 120, 0.7, 0.8],
  ['M235 160 H278', 120, 0.6, 0.9],
  ['M278 176 H300', 120, 0.6, 0.86],
  ['M330 176 H392', 120, 0.7, 0.96],
];

/** door swing arc: [d, dash, delay s] */
const DOORS: [string, number, number][] = [
  ['M160 124 A32 32 0 0 0 192 92', 60, 1.5],
  ['M160 176 A32 32 0 0 1 128 208', 60, 1.6],
  ['M278 92 A30 30 0 0 1 248 122', 58, 1.55],
  ['M278 196 A28 28 0 0 0 306 224', 54, 1.65],
  ['M205 160 A30 30 0 0 1 235 190', 58, 1.6],
];

function delay(s: number) {
  return { ['--delay' as string]: `${s}s` };
}

export function FloorplanSkeleton() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % MESSAGES.length), 1900);
    return () => clearInterval(t);
  }, []);

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <svg viewBox="0 0 432 312" fill="none" className={styles.plan} aria-hidden>
          {/* room zone tints */}
          <g className={styles.rise} style={delay(1.5)}>
            <rect x="40" y="40" width="120" height="120" fill="rgba(0,89,214,0.03)" />
            <rect x="278" y="40" width="114" height="120" fill="rgba(46,209,255,0.045)" />
            <rect x="278" y="176" width="114" height="96" fill="rgba(41,160,30,0.04)" />
          </g>

          {/* interior walls (draw in) */}
          <g stroke="#98A4B8" strokeWidth="7" strokeLinecap="butt">
            {WALLS.map(([d, dash, dur, del]) => (
              <path
                key={d}
                d={d}
                strokeDasharray={dash}
                strokeDashoffset={dash}
                className={styles.draw}
                style={{ ['--dur' as string]: `${dur}s`, ['--delay' as string]: `${del}s` }}
              />
            ))}
          </g>

          {/* outer wall (draws first, sits on top) */}
          <rect
            x="40"
            y="40"
            width="352"
            height="232"
            rx="3"
            stroke="#7E8CA3"
            strokeWidth="9"
            strokeLinejoin="round"
            strokeDasharray={1200}
            strokeDashoffset={1200}
            className={styles.draw}
            style={{ ['--dur' as string]: '1.5s', ['--delay' as string]: '0s' }}
          />

          {/* windows cut into the outer wall */}
          <g className={styles.rise} style={delay(1.5)}>
            <rect x="86" y="35.5" width="42" height="9" fill="#fff" />
            <rect x="88" y="38.5" width="38" height="3" rx="1.5" fill="#E3E9F2" />
            <rect x="196" y="35.5" width="42" height="9" fill="#fff" />
            <rect x="198" y="38.5" width="38" height="3" rx="1.5" fill="#E3E9F2" />
            <rect x="306" y="35.5" width="42" height="9" fill="#fff" />
            <rect x="308" y="38.5" width="38" height="3" rx="1.5" fill="#E3E9F2" />
            <rect x="35.5" y="96" width="9" height="42" fill="#fff" />
            <rect x="38.5" y="98" width="3" height="38" rx="1.5" fill="#E3E9F2" />
            <rect x="387.5" y="200" width="9" height="42" fill="#fff" />
            <rect x="390.5" y="202" width="3" height="38" rx="1.5" fill="#E3E9F2" />
            <rect x="196" y="267.5" width="42" height="9" fill="#fff" />
            <rect x="198" y="270.5" width="38" height="3" rx="1.5" fill="#E3E9F2" />
          </g>

          {/* door swing arcs */}
          <g stroke="#B4BFD0" strokeWidth="1.4" fill="none">
            {DOORS.map(([d, dash, del]) => (
              <path
                key={d}
                d={d}
                strokeDasharray={dash}
                strokeDashoffset={dash}
                className={styles.drawEase}
                style={{ ['--dur' as string]: '0.45s', ['--delay' as string]: `${del}s` }}
              />
            ))}
          </g>

          {/* furniture */}
          <g stroke="#C4CEDD" strokeWidth="1.4" fill="#F2F5FA" strokeLinejoin="round">
            {/* living: sofa + coffee table + plant */}
            <g className={styles.rise} style={delay(1.15)}>
              <rect x="54" y="54" width="52" height="22" rx="3" />
              <rect x="57" y="50" width="46" height="7" rx="2.5" />
              <line x1="80" y1="56" x2="80" y2="74" />
            </g>
            <g className={styles.rise} style={delay(1.24)}>
              <circle cx="72" cy="112" r="14" />
            </g>
            <g className={styles.rise} style={{ ...delay(1.32), fill: 'none', stroke: '#B9C6D9' }}>
              <circle cx="124" cy="100" r="3.5" fill="#EAF1FA" />
              <path d="M124 100 L124 90 M124 100 L133 96 M124 100 L131 108 M124 100 L117 108 M124 100 L115 96" />
              <rect x="120" y="112" width="8" height="7" rx="1" fill="#F2F5FA" />
            </g>
            {/* bathroom: tub + toilet + sink */}
            <g className={styles.rise} style={delay(1.2)}>
              <rect x="170" y="52" width="26" height="52" rx="8" />
              <rect x="174" y="60" width="18" height="40" rx="6" fill="#fff" />
            </g>
            <g className={styles.rise} style={delay(1.28)}>
              <rect x="230" y="52" width="20" height="9" rx="2" />
              <ellipse cx="240" cy="70" rx="10" ry="11" />
            </g>
            <g className={styles.rise} style={delay(1.36)}>
              <rect x="228" y="92" width="26" height="16" rx="3" />
              <ellipse cx="241" cy="100" rx="7" ry="5" fill="#fff" />
            </g>
            {/* bedroom 1 (top-right) */}
            <g className={styles.rise} style={delay(1.3)}>
              <rect x="316" y="54" width="58" height="44" rx="3" />
              <rect x="320" y="58" width="50" height="14" rx="2" fill="#fff" />
              <rect x="352" y="52" width="12" height="10" rx="2" />
            </g>
            {/* bedroom 2 (bottom-left) */}
            <g className={styles.rise} style={delay(1.4)}>
              <rect x="56" y="196" width="46" height="60" rx="3" />
              <rect x="60" y="200" width="38" height="14" rx="2" fill="#fff" />
            </g>
            {/* dining: table + chairs */}
            <g className={styles.rise} style={delay(1.34)}>
              <rect x="196" y="204" width="46" height="30" rx="4" />
              <rect x="200" y="192" width="16" height="9" rx="2" />
              <rect x="222" y="192" width="16" height="9" rx="2" />
              <rect x="200" y="237" width="16" height="9" rx="2" />
              <rect x="222" y="237" width="16" height="9" rx="2" />
            </g>
            {/* kitchen: counter + stove + sink */}
            <g className={styles.rise} style={delay(1.44)}>
              <rect x="300" y="240" width="86" height="20" rx="2" />
              <rect x="366" y="196" width="20" height="44" rx="2" />
              <rect x="312" y="244" width="18" height="12" rx="2" fill="#fff" />
              <circle cx="352" cy="250" r="3.5" />
              <circle cx="362" cy="250" r="3.5" />
              <circle cx="352" cy="256" r="2.6" />
              <ellipse cx="376" cy="212" rx="6" ry="8" fill="#fff" />
            </g>
          </g>
        </svg>

        {/* scan beam */}
        <div className={styles.beamBand} />
        <div className={styles.beamLine} />
      </div>

      <div className={styles.footer}>
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} />
        </div>
        <div className={styles.label}>
          <span key={i} className={styles.message}>
            {MESSAGES[i]}
          </span>
          <span className={styles.msgDot}>.</span>
          <span className={styles.msgDot} style={delay(0.2)}>
            .
          </span>
          <span className={styles.msgDot} style={delay(0.4)}>
            .
          </span>
        </div>
      </div>
    </div>
  );
}
