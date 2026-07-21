/** Tiny inline spinner for buttons in a busy state (e.g. "Saving…"). SMIL-rotated, no CSS needed. */
export function ButtonSpinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" style={{ marginRight: 6, flexShrink: 0 }} aria-hidden>
      <path d="M12 3a9 9 0 1 1-9 9">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}
