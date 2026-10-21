import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Window sizes are driven by content, so viewport units would be circular. Size limits come from the screen.
document.documentElement.style.setProperty('--avail', `${window.screen.availHeight}px`);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
