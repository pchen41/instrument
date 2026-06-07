import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { telemetry } from './lib/telemetry';
import './index.css';

// Initialize frontend telemetry. No-op (and never loads the RUM SDK) when
// browser-safe Datadog RUM config is absent — the default for the demo.
void telemetry.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
