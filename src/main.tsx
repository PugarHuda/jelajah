import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The router reads location.hash on render: remount the app whenever the hash changes, so every plain
// <a href="#/…"> link works (a back button too), not only the ones that force a reload.
// oxlint-disable-next-line react/only-export-components -- entry file, no fast refresh needed here
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => { setHash(location.hash); scrollTo(0, 0); };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return <App key={hash} />;
}

// offline shell (public/sw.js): a stall with weak signal still opens the app; production builds only
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch((e) => console.warn('service worker', e));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
