import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { NotificationProvider } from './contexts/NotificationContext';
import './index.css';

// Crash prevention - Global error handlers
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  event.preventDefault(); // Prevent default error handling
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  event.preventDefault(); // Prevent default error handling
});

// Wait for DOM to be ready
function initApp() {
  const rootElement = document.getElementById('root');

  if (!rootElement) {
    // Create root element if it doesn't exist
    const newRoot = document.createElement('div');
    newRoot.id = 'root';
    document.body.appendChild(newRoot);

    const root = ReactDOM.createRoot(newRoot);
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <NotificationProvider>
            <App />
          </NotificationProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );
    return;
  }

  try {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <NotificationProvider>
            <App />
          </NotificationProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    console.error('Failed to render app:', error);
    // Fallback UI
    rootElement.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; font-family: system-ui;">
        <h1 style="color: #ef4444; margin-bottom: 1rem;">Uygulama Yüklenemedi</h1>
        <p style="color: #6b7280; margin-bottom: 1rem;">Lütfen sayfayı yenileyin.</p>
        <button onclick="window.location.reload()" style="padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 0.25rem; cursor: pointer;">
          Yenile
        </button>
      </div>
    `;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
