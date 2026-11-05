import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
/*
 * The product face: IBM Plex Sans + IBM Plex Mono, self-hosted (SIL OFL 1.1).
 * The Sans is the width-axis build (`wdth.css`, weight 100-700 and width
 * 75-100): 12px form labels are set at `font-stretch: 87.5%`.
 * Bundled rather than fetched from a font CDN because the CSP is
 * `font-src 'self'`: Vite emits each woff2 as a hashed same-origin asset (every
 * subset is over the 4 KiB inline limit, so none becomes a `data:` URI the CSP
 * would block). Each `@font-face` carries a `unicode-range`, so a browser only
 * downloads the subsets a page actually renders — normally just Latin. Italic
 * is imported for the few places that set it (transcript asides, "Not
 * described"), so they get the drawn italic instead of a slanted upright.
 */
import '@fontsource-variable/ibm-plex-sans/wdth.css';
import '@fontsource-variable/ibm-plex-sans/wdth-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './lib/auth.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
