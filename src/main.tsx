import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

/*
 * ══ SERVICE WORKER REGISTRATION ═══════════════════════════════════════════
 * The previous code registered inside a `window.addEventListener('load', …)`.
 *
 * That is a race, and it loses. `load` fires once every asset has finished; a
 * bundle that arrives after it has already gone leaves the listener attached to
 * an event that will not fire again, so the worker is NEVER registered and the
 * app silently has no offline support. It happens on a slow connection or a
 * warm cache — exactly when a till is least able to recover.
 *
 * `document.readyState` is therefore checked first, and the worker registers
 * immediately when the page is already loaded.
 *
 * ══ WHY THE SCOPE IS EXPLICIT ═════════════════════════════════════════════
 * Without `{ scope: '/' }` the worker takes scope from wherever it is served
 * from. Stated rather than assumed, because a worker that fails to claim the
 * root scope serves nothing and the offline behaviour becomes intermittent in a
 * way that is very hard to diagnose in the field.
 */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  const registerWorker = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        /*
         * Watch for a new worker.
         *
         * Without this, a deployed fix never reaches an operator who leaves the
         * app open all shift: the new worker waits in `waiting`, and the old one
         * keeps serving until every tab is closed. On a till that is open from
         * opening to close, that can be days — and the person debugging it sees
         * the old bundle with no explanation.
         */
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version is ready behind the open one. The reload is left to
              // the shell so it can be announced and confirmed rather than
              // swapping the page out from under an operator mid-sale.
              window.dispatchEvent(new CustomEvent('dypos:update-ready'));
            }
          });
        });
      })
      .catch((err) => {
        // Logged, never surfaced. A worker that cannot register leaves the app
        // fully usable online; failing loudly here would alarm an operator about
        // something they cannot act on.
        console.warn('Service worker registration failed:', err);
      });
  };

  if (document.readyState === 'complete') {
    registerWorker();
  } else {
    window.addEventListener('load', registerWorker, { once: true });
  }
}

// Outer boundary: if the shell itself fails, the operator still gets a usable
// page with a reload instead of an empty document.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="النظام">
    <App />
  </ErrorBoundary>,
);
