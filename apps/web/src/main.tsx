import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { reloadForStaleChunk } from './components/ErrorBoundary.tsx';
import { initAnalytics } from './lib/analytics.ts';
import { RouterProvider } from './lib/router.tsx';
import { SessionProvider } from './lib/session.tsx';

window.addEventListener('vite:preloadError', (event) => {
  if (reloadForStaleChunk()) event.preventDefault();
});

initAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </RouterProvider>
  </StrictMode>,
);
