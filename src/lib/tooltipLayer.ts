/**
 * ONE tooltip element for the whole app, positioned in VIEWPORT space.
 *
 * The tooltips were CSS-only (`[data-tip]::after`), which meant every bubble lived INSIDE its
 * anchor's box and any scrolling or clipping ancestor cut it off — the portfolio tree's scroll
 * area sliced the site-name bubble in half and added a horizontal scrollbar (reported). No amount
 * of per-component `overflow` fixing solves that: a scroll container must clip its content.
 *
 * So the bubble is a single fixed-position node under <body>, outside every panel, popover and
 * scroll box. The authoring API is unchanged — put `data-tip="…"` on anything, with the same
 * `data-tip-pos` / `data-tip-align` / `data-tip-side` hints honoured as PREFERENCES; the real
 * placement is computed from the anchor's rect and flips to stay on screen.
 */
const DELAY_MS = 200;
const GAP = 6;
const EDGE = 8;

let bubble: HTMLDivElement | null = null;
let showTimer: number | null = null;
let anchor: HTMLElement | null = null;

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  const el = document.createElement('div');
  el.className = 'fp-tip';
  el.setAttribute('role', 'tooltip');
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  bubble = el;
  return el;
}

function hide(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  anchor = null;
  if (bubble) {
    bubble.classList.remove('fp-tip-on');
    bubble.setAttribute('aria-hidden', 'true');
  }
}

function place(el: HTMLElement, text: string): void {
  const tip = ensureBubble();
  tip.textContent = text;
  tip.classList.add('fp-tip-on');
  tip.setAttribute('aria-hidden', 'false');

  const r = el.getBoundingClientRect();
  // Measured only once it's laid out with its real text.
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const prefersTop = el.getAttribute('data-tip-pos') === 'top';
  const side = el.getAttribute('data-tip-side');
  const align = el.getAttribute('data-tip-align');

  let top = prefersTop ? r.top - h - GAP : r.bottom + GAP;
  // Flip when the preferred side has no room; clamp as a last resort.
  if (!prefersTop && top + h > window.innerHeight - EDGE) top = r.top - h - GAP;
  if (prefersTop && top < EDGE) top = r.bottom + GAP;
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, window.innerHeight - h - EDGE));

  let left: number;
  if (side === 'left') left = r.left - w - GAP;
  else if (side === 'right') left = r.right + GAP;
  else if (align === 'center') left = r.left + r.width / 2 - w / 2;
  else if (align === 'end') left = r.right - w;
  else left = r.left;
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE));

  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function tipTextFor(target: EventTarget | null): { el: HTMLElement; text: string } | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-tip]');
  if (!el) return null;
  const text = (el.getAttribute('data-tip') ?? '').trim();
  // An empty data-tip is the documented way to suppress a tooltip (e.g. a Select while open).
  return text ? { el, text } : null;
}

function onOver(e: Event): void {
  const hit = tipTextFor(e.target);
  if (!hit) return;
  if (hit.el === anchor) return;
  hide();
  anchor = hit.el;
  showTimer = window.setTimeout(() => {
    showTimer = null;
    // The pointer may have left during the delay.
    if (anchor === hit.el && hit.el.isConnected) place(hit.el, hit.text);
  }, DELAY_MS);
}

function onOut(e: Event): void {
  const related = (e as MouseEvent).relatedTarget;
  if (related instanceof Element && anchor?.contains(related)) return;
  hide();
}

/** Call once at boot. Idempotent. */
export function installTooltipLayer(): void {
  if (typeof window === 'undefined' || (window as any).__fpTipInstalled) return;
  (window as any).__fpTipInstalled = true;
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', onOver, true);
  document.addEventListener('focusout', hide, true);
  // A bubble pinned to viewport coordinates would drift away from its anchor on scroll, and the
  // anchor can scroll out of its own container entirely — so it simply closes.
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') hide();
  });
}
