import { createRoot } from 'react-dom/client';
import './splash';
import App from './App';

createRoot(document.getElementById('root')).render(<App />);

// Fade out the boot splash once React has painted; keep it at least ~1.8s so the intro animation completes
const splash = document.getElementById('splash');
if (splash) {
  setTimeout(
    () => {
      splash.classList.add('is-done');
      setTimeout(() => {
        clearInterval(window.__splashTimer);
        splash.remove();
      }, 550);
    },
    Math.max(0, 1800 - performance.now())
  );
}
