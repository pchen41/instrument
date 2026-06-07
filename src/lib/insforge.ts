import { createClient } from '@insforge/sdk';

// Browser-safe InsForge client. Uses the public anon key only — never the
// admin api_key. Values come from VITE_ env vars (see .env.example).
//
// First-slice auth is username/password sign-in for a single configured
// workspace (PRD SEC-2). No signup or OAuth flow is wired in the demo.
const baseUrl = import.meta.env.VITE_INSFORGE_URL ?? '';
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY ?? '';

if (import.meta.env.DEV && (!baseUrl || !anonKey)) {
  // Surfaced at dev time only; production builds fail loudly elsewhere if the
  // SDK cannot reach the backend.
  // eslint-disable-next-line no-console
  console.warn(
    '[insforge] VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY are not set. ' +
      'Copy .env.example to .env.local and fill in the browser-safe values.',
  );
}

export const insforge = createClient({ baseUrl, anonKey });

// Exposed for the auth layer's cross-domain session restore (the SPA and the API
// are on different domains, so the cookie refresh flow can't be used).
export const insforgeUrl = baseUrl;
export const insforgeAnonKey = anonKey;
