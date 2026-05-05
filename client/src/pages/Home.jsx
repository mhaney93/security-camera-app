import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  function createCamera() {
    navigate(`/camera/${generateCode()}`);
  }

  function joinViewer() {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 4) {
      setError('Enter at least 4 characters');
      return;
    }
    navigate(`/viewer/${trimmed}`);
  }

  return (
    <div className="page">
      <div className="home-logo">
        <h1>Secure<span>Cam</span></h1>
        <p>Browser-based security camera</p>
      </div>

      <div className="card">
        <h2>Start Camera</h2>
        <p>Turn this device into a live security camera. Share the room code with a viewer.</p>
        <button className="btn-primary" onClick={createCamera}>
          Create Camera Room
        </button>
      </div>

      <div className="card">
        <h2>View Camera</h2>
        <p>Watch a camera stream remotely. Enter the room code from the camera device.</p>
        <input
          type="text"
          placeholder="Room code"
          value={code}
          maxLength={10}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError('');
          }}
          onKeyDown={(e) => e.key === 'Enter' && joinViewer()}
        />
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
        <button className="btn-primary" onClick={joinViewer}>
          Connect as Viewer
        </button>
      </div>

      <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.8rem', marginTop: 'auto' }}>
        Requires HTTPS for camera/mic/GPS access when not on localhost.
      </p>
    </div>
  );
}
