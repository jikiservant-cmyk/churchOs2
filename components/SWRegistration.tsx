'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker.
 *
 * The previous version skipped registration on `localhost` entirely, so the
 * worker was never exercised during development — which is how a cache-first
 * worker that served stale HTML survived. Registration is unconditional here;
 * if the worker misbehaves in development, the fix is in the worker.
 */
export default function SWRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Register after load so the worker never competes with the first paint.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registration) => {
          // Pick up a new deploy without requiring two hard reloads.
          registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener('statechange', () => {
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                // A replacement is ready; activate it on the next navigation.
                registration.waiting?.postMessage('SKIP_WAITING');
              }
            });
          });
        })
        .catch((error) => {
          console.warn('[pwa] Service worker registration failed:', error);
        });
    };

    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
