import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTooltipLayer } from './lib/tooltipLayer';
import App from './App';
import './styles/global.css';

// Deployed only: the route-rescue worker (public/sw.js) that makes /bookings, /people and
// /settings survive refresh/deep-links on the vibe static host — see the comment in sw.js.
// Skipped in dev, where the vite server handles SPA fallback itself and a worker would only
// interfere with HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// One tooltip node for the app, outside every panel and scroll box.
installTooltipLayer();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
