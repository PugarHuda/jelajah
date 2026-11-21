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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
