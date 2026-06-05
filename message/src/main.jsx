import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Service Worker 등록 (Web Push 지원)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/freeChat/sw.js')
      .then(reg => {
        console.log('[SW] 등록 완료:', reg.scope);
        window.__swRegistration = reg;
      })
      .catch(err => console.log('[SW] 등록 실패:', err));
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
