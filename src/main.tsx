import './lib/legacyStorage'; // first: moves old saved UI state before the stores read it
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@glideapps/glide-data-grid/dist/index.css';
import './styles.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { applyThemeAttribute, useApp } from './store/app';

// set the theme before the first paint, so the window does not flash light
applyThemeAttribute(useApp.getState().theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
