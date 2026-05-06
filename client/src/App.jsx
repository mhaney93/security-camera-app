import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Camera from './pages/Camera';
import Viewer from './pages/Viewer';

function Lock({ onUnlock }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (!value.trim()) { setError('Enter the app password'); return; }
    sessionStorage.setItem('app_secret', value.trim());
    onUnlock();
  }

  return (
    <div className="page" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="card" style={{ width: '100%', maxWidth: 360 }}>
        <h2>SecureCam</h2>
        <p>Enter the app password to continue.</p>
        <input
          type="password"
          placeholder="Password"
          value={value}
          style={{ letterSpacing: 0 }}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
        <button className="btn-primary" onClick={submit}>Unlock</button>
      </div>
    </div>
  );
}

export default function App() {
  const [unlocked, setUnlocked] = useState(!!sessionStorage.getItem('app_secret'));

  if (!unlocked) return <Lock onUnlock={() => setUnlocked(true)} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/camera/:roomId" element={<Camera />} />
        <Route path="/viewer/:roomId" element={<Viewer />} />
      </Routes>
    </BrowserRouter>
  );
}
