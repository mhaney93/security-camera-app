import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket, apiFetch } from '../socket';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const CAMERA_ICON = L.divIcon({
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#00e676;border:3px solid #fff;box-shadow:0 0 6px #00e676"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  className: '',
});

function requestFullscreen(el) {
  if (!el) return;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
}

export default function Viewer() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const recVideoRef = useRef(null);
  const pc = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const pathRef = useRef(null);
  const pathCoords = useRef([]);
  const fetchedAddressKeys = useRef(new Set());

  // null = checking, true = exists, false = not found
  const [roomExists, setRoomExists] = useState(null);
  const [addresses, setAddresses] = useState({});

  const [connected, setConnected] = useState(false);
  const [cameraOnline, setCameraOnline] = useState(false);
  const [gps, setGps] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [gpsHistory, setGpsHistory] = useState([]);
  const [tab, setTab] = useState('map');
  const [loadingRec, setLoadingRec] = useState(false);
  const [motionAlert, setMotionAlert] = useState(false);
  const [isDeafened, setIsDeafened] = useState(true);
  const [playingRec, setPlayingRec] = useState(null);

  // Check if the room exists before doing anything
  useEffect(() => {
    apiFetch(`/api/rooms/${roomId}/exists`)
      .then(r => r.json())
      .then(({ exists }) => setRoomExists(exists))
      .catch(() => setRoomExists(true)); // fail open on network error
  }, [roomId]);

  // Init Leaflet map — only once room is confirmed
  useEffect(() => {
    if (roomExists !== true) return;
    const map = L.map(mapDivRef.current, { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    markerRef.current = L.marker([20, 0], { icon: CAMERA_ICON }).addTo(map);
    pathRef.current = L.polyline([], { color: '#00e676', weight: 3, opacity: 0.7 }).addTo(map);
    return () => map.remove();
  }, [roomExists]);

  useEffect(() => {
    if (tab === 'map') setTimeout(() => mapRef.current?.invalidateSize(), 50);
  }, [tab]);

  function formatAddress(addr) {
    if (!addr) return '';
    const parts = [
      addr.road || addr.pedestrian || addr.footway || addr.path,
      addr.city || addr.town || addr.village || addr.hamlet || addr.suburb,
      addr.state,
    ].filter(Boolean);
    return parts.join(', ');
  }

  // Fetch addresses for GPS log points when the GPS tab is open
  useEffect(() => {
    if (tab !== 'gps' || gpsHistory.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const point of gpsHistory) {
        if (cancelled) break;
        const key = `${point.lat},${point.lng}`;
        if (fetchedAddressKeys.current.has(key)) continue;
        fetchedAddressKeys.current.add(key);
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${point.lat}&lon=${point.lng}&format=json`,
            { headers: { 'User-Agent': 'ACME-SecurityCam/1.0' } }
          );
          const data = await res.json();
          if (!cancelled) {
            const addr = formatAddress(data.address) || data.display_name || '';
            setAddresses(prev => ({ ...prev, [key]: addr }));
          }
        } catch { /* ignore */ }
        if (!cancelled) await new Promise(r => setTimeout(r, 1100));
      }
    })();
    return () => { cancelled = true; };
  }, [tab, gpsHistory]);

  const updateMap = useCallback((lat, lng) => {
    if (!mapRef.current) return;
    const latlng = [lat, lng];
    markerRef.current.setLatLng(latlng);
    pathCoords.current.push(latlng);
    pathRef.current.setLatLngs(pathCoords.current);
    mapRef.current.setView(latlng, Math.max(mapRef.current.getZoom(), 15), { animate: true });
  }, []);

  async function loadGpsHistory() {
    try {
      const res = await apiFetch(`/api/gps/${roomId}`);
      const data = await res.json();
      setGpsHistory(data);
      if (data.length > 0 && mapRef.current) {
        const coords = [...data].reverse().map((p) => [p.lat, p.lng]);
        pathCoords.current = coords;
        pathRef.current?.setLatLngs(coords);
        const last = coords[coords.length - 1];
        markerRef.current?.setLatLng(last);
        mapRef.current.setView(last, 15);
      }
    } catch { /* ignore */ }
  }

  async function loadRecordings() {
    setLoadingRec(true);
    try {
      const res = await apiFetch(`/api/recordings/${roomId}`);
      setRecordings(await res.json());
    } catch { /* ignore */ }
    setLoadingRec(false);
  }

  // Socket connection — only once room is confirmed
  useEffect(() => {
    if (roomExists !== true) return;

    socket.connect();
    socket.emit('join-room', { roomId, role: 'viewer' });

    socket.on('room-joined', ({ hasCamera }) => setCameraOnline(!!hasCamera));

    socket.on('camera-disconnected', () => {
      setCameraOnline(false);
      setConnected(false);
      if (videoRef.current) videoRef.current.srcObject = null;
      pc.current?.close();
      pc.current = null;
    });

    socket.on('webrtc-offer', async ({ offer, fromId }) => {
      const conn = new RTCPeerConnection(ICE_CONFIG);
      pc.current = conn;

      conn.ontrack = ({ streams }) => {
        if (videoRef.current) {
          videoRef.current.srcObject = streams[0];
          videoRef.current.muted = true;
          videoRef.current.play().catch(() => {});
        }
        setConnected(true);
      };

      conn.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('webrtc-ice', { candidate, targetId: fromId });
      };

      conn.onconnectionstatechange = () => {
        if (['disconnected', 'failed'].includes(conn.connectionState)) setConnected(false);
      };

      await conn.setRemoteDescription(offer);
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      socket.emit('webrtc-answer', { answer, targetId: fromId });
    });

    socket.on('webrtc-ice', async ({ candidate }) => {
      try { await pc.current?.addIceCandidate(candidate); } catch { /* ignore */ }
    });

    socket.on('gps-update', ({ lat, lng, accuracy, timestamp }) => {
      setGps({ lat, lng, accuracy, timestamp });
      updateMap(lat, lng);
    });

    socket.on('motion-detected', () => {
      setMotionAlert(true);
      setTimeout(() => setMotionAlert(false), 8000);
    });

    loadGpsHistory();
    loadRecordings();

    return () => {
      pc.current?.close();
      socket.off('room-joined');
      socket.off('camera-disconnected');
      socket.off('webrtc-offer');
      socket.off('webrtc-ice');
      socket.off('gps-update');
      socket.off('motion-detected');
      socket.disconnect();
    };
  }, [roomId, updateMap, roomExists]);

  if (roomExists === null) {
    return (
      <div className="page" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: 'var(--muted)' }}>Checking room...</p>
      </div>
    );
  }

  if (roomExists === false) {
    return (
      <div className="page" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="card" style={{ maxWidth: 360, width: '100%', textAlign: 'center', gap: 16 }}>
          <div style={{ fontSize: '2.5rem' }}>📷</div>
          <h2 style={{ color: 'var(--danger)' }}>Room not found</h2>
          <p>That room doesn't exist. Double-check the room code and try again.</p>
          <button className="btn-primary" onClick={() => navigate('/')}>Go Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="viewer-header">
        <h2>Room <strong>{roomId}</strong></h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {connected ? (
            <span className="badge badge-live"><span className="dot" /> Live</span>
          ) : cameraOnline ? (
            <span className="badge badge-waiting">Connecting...</span>
          ) : (
            <span className="badge badge-waiting">No camera</span>
          )}
          <button className="btn-ghost btn-sm" onClick={() => navigate('/')}>Back</button>
        </div>
      </div>

      {motionAlert && <div className="motion-alert">Motion detected!</div>}

      <div style={{ position: 'relative' }}>
        <video ref={videoRef} autoPlay playsInline className="remote-video" />
        <button
          className="video-overlay-btn left"
          title={isDeafened ? 'Unmute audio' : 'Mute audio'}
          onClick={() => {
            const next = !isDeafened;
            if (videoRef.current) videoRef.current.muted = next;
            setIsDeafened(next);
          }}
        >
          {isDeafened ? '🔇' : '🔊'}
        </button>
        <button className="video-overlay-btn right" onClick={() => requestFullscreen(videoRef.current)} title="Fullscreen">⛶</button>
      </div>

      {gps && (
        <div className="gps-info">
          <strong>GPS</strong>&nbsp; {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          &nbsp;&nbsp;±{Math.round(gps.accuracy ?? 0)}m
          &nbsp;&nbsp;{new Date(gps.timestamp).toLocaleTimeString()}
        </div>
      )}

      <div className="tabs">
        <button className={`tab-btn${tab === 'map' ? ' active' : ''}`} onClick={() => setTab('map')}>Map</button>
        <button className={`tab-btn${tab === 'recordings' ? ' active' : ''}`} onClick={() => { setTab('recordings'); loadRecordings(); }}>Recordings</button>
        <button className={`tab-btn${tab === 'gps' ? ' active' : ''}`} onClick={() => setTab('gps')}>GPS Log</button>
      </div>

      <div ref={mapDivRef} className={`map-container${tab !== 'map' ? ' hidden' : ''}`} />

      {tab === 'recordings' && (
        <div className="recordings-list">
          {playingRec && (
            <div className="recording-player">
              <div className="recording-player-header">
                <span>{new Date(Number(playingRec.timestamp)).toLocaleString()}</span>
                <button className="btn-ghost btn-sm" onClick={() => setPlayingRec(null)}>Close</button>
              </div>
              <div style={{ position: 'relative' }}>
                <video
                  ref={recVideoRef}
                  src={`/api/recordings/file/${playingRec.filename}`}
                  controls
                  playsInline
                  autoPlay
                  className="recording-video"
                />
                <button className="video-overlay-btn right" onClick={() => requestFullscreen(recVideoRef.current)} title="Fullscreen">⛶</button>
              </div>
            </div>
          )}
          {loadingRec ? (
            <p className="empty-state">Loading...</p>
          ) : recordings.length === 0 ? (
            <p className="empty-state">No recordings yet. Recordings appear every 5 minutes while the camera is active.</p>
          ) : (
            recordings.map((rec) => (
              <div key={rec.id} className={`recording-item${playingRec?.id === rec.id ? ' active' : ''}`}>
                <span>
                  {new Date(Number(rec.timestamp)).toLocaleString()}
                  {rec.lat != null && rec.lng != null && (
                    <span className="rec-gps"> &nbsp;{Number(rec.lat).toFixed(5)}, {Number(rec.lng).toFixed(5)}</span>
                  )}
                </span>
                <button className="btn-ghost btn-sm" onClick={() => setPlayingRec(playingRec?.id === rec.id ? null : rec)}>
                  {playingRec?.id === rec.id ? 'Close' : 'Play'}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'gps' && (
        <div className="gps-history">
          {gpsHistory.length === 0 ? (
            <p className="empty-state">No GPS history for this room yet.</p>
          ) : (
            gpsHistory.map((p) => {
              const key = `${p.lat},${p.lng}`;
              const address = addresses[key];
              return (
                <div key={p.id} className="gps-point">
                  <span>{new Date(Number(p.timestamp)).toLocaleString()}</span>
                  {'  '}
                  {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                  {p.accuracy ? `  ±${Math.round(p.accuracy)}m` : ''}
                  {address !== undefined && (
                    <div className="gps-address">{address || 'Address unavailable'}</div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
