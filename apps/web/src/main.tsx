import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Tokens and shared components first, so a panel's own stylesheet (imported with it) can refine them.
import './styles/tokens.css';
import './styles/ui.css';
import './styles/app.css';
import { App } from './App';
import { startAnalytics } from './analytics';

// Hosted build only: cookieless visit counts and page speed, every page view filed under /app.
startAnalytics('/app');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
