import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket } from '../socket';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

// Compares two ImageData frames; returns true if enough pixels changed.
function hasMotion(prev, curr, pixelThreshold = 25, motionPct = 1.5) {
  const d1 = prev.data;
  const d2 = curr.data;
  let changed = 0;
  const total = d1.length / 4;
  for (let i = 0; i < d1.length; i += 4) {
    const diff = (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2])) / 3;
    if (diff > pixelThreshold) changed++;
  }
  return (changed / total) * 100 > motionPct;
}

export default function Camera() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const prevFrame = useRef(null);
  const motionTimer = useRef(null);
  const motionOnCooldown = useRef(false);
  const localStream = useRef(null);
  const peers = useRef({});
  const recorder = useRef(null);
  const recInterval = useRef(null);
  const gpsWatcher = useRef(null);
  const gpsRef = useRef(null);
  const isMounted = useRef(true);

  const [status, setStatus] = useState('Starting...');
  const [viewerCount, setViewerCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [motionActive, setMotionActive] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [gps, setGps] = useState(null);
  const [copied, setCopied] = useState(false);
  const [usingBack, setUsingBack] = useState(true);

  const uploadChunk = useCallback(
    async (blob, lat, lng) => {
      if (blob.size === 0) return;
      const form = new FormData();
      form.append('chunk', blob, 'recording.webm');
      if (lat != null) form.append('lat', String(lat));
      if (lng != null) form.append('lng', String(lng));
      try {
        await fetch(`/api/upload/${roomId}`, { method: 'POST', body: form });
      } catch {
        // silently ignore upload failures — will retry on next chunk
      }
    },
    [roomId]
  );

  const startRecording = useCallback(
    (stream) => {
      const mimeType = getSupportedMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const chunks = [];
      const startGps = gpsRef.current;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
        chunks.length = 0;
        uploadChunk(blob, startGps?.lat, startGps?.lng);
      };

      rec.start();
      recorder.current = rec;
      setIsRecording(true);

      // Rotate every 5 minutes so each file is independently playable
      recInterval.current = setInterval(() => {
        if (recorder.current?.state === 'recording') {
          recorder.current.stop();
          setTimeout(() => {
            if (isMounted.current) startRecording(stream);
          }, 500);
        }
      }, 5 * 60 * 1000);
    },
    [uploadChunk]
  );

  const startMotionDetection = useCallback((video) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 320;
    canvas.height = 180;

    function check() {
      if (!isMounted.current) return;

      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, 320, 180);
        const curr = ctx.getImageData(0, 0, 320, 180);

        if (prevFrame.current && !motionOnCooldown.current) {
          if (hasMotion(prevFrame.current, curr)) {
            motionOnCooldown.current = true;
            setMotionActive(true);
            socket.emit('motion-detected', { roomId });
            setTimeout(() => {
              motionOnCooldown.current = false;
              setMotionActive(false);
            }, 60 * 1000);
          }
        }

        prevFrame.current = curr;
      }

      motionTimer.current = setTimeout(check, 1000);
    }

    // Give the video a moment to start playing before first comparison
    motionTimer.current = setTimeout(check, 2000);
  }, [roomId]);

  const createPeerConnection = useCallback((viewerId) => {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    peers.current[viewerId] = pc;

    localStream.current?.getTracks().forEach((t) => pc.addTrack(t, localStream.current));

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('webrtc-ice', { candidate, targetId: viewerId });
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        delete peers.current[viewerId];
      }
    };

    return pc;
  }, []);

  useEffect(() => {
    isMounted.current = true;

    async function init() {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: usingBack ? 'environment' : 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
      } catch {
        setStatus('Camera access denied — check browser permissions');
        return;
      }

      localStream.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      socket.connect();
      socket.emit('join-room', { roomId, role: 'camera' });

      socket.on('room-joined', ({ viewerCount: vc }) => {
        setViewerCount(vc);
        setStatus('Live');
      });

      socket.on('viewer-joined', async ({ viewerId }) => {
        if (!isMounted.current) return;
        setViewerCount((c) => c + 1);
        const pc = createPeerConnection(viewerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { offer, targetId: viewerId });
      });

      socket.on('viewer-left', ({ viewerId }) => {
        setViewerCount((c) => Math.max(0, c - 1));
        peers.current[viewerId]?.close();
        delete peers.current[viewerId];
      });

      socket.on('webrtc-answer', async ({ answer, fromId }) => {
        try {
          await peers.current[fromId]?.setRemoteDescription(answer);
        } catch { /* ignore race conditions */ }
      });

      socket.on('webrtc-ice', async ({ candidate, fromId }) => {
        try {
          await peers.current[fromId]?.addIceCandidate(candidate);
        } catch { /* ignore */ }
      });

      if ('geolocation' in navigator) {
        gpsWatcher.current = navigator.geolocation.watchPosition(
          ({ coords }) => {
            const { latitude: lat, longitude: lng, accuracy } = coords;
            const point = { lat, lng, accuracy };
            setGps(point);
            gpsRef.current = point;
            socket.emit('gps-update', { roomId, lat, lng, accuracy, timestamp: Date.now() });
          },
          null,
          { enableHighAccuracy: true, maximumAge: 5000 }
        );
      }

      startRecording(stream);
      startMotionDetection(videoRef.current);
    }

    init();

    return () => {
      isMounted.current = false;
      clearTimeout(motionTimer.current);
      clearInterval(recInterval.current);
      if (recorder.current?.state === 'recording') recorder.current.stop();
      if (gpsWatcher.current != null) navigator.geolocation.clearWatch(gpsWatcher.current);
      Object.values(peers.current).forEach((pc) => pc.close());
      peers.current = {};
      localStream.current?.getTracks().forEach((t) => t.stop());
      socket.off('room-joined');
      socket.off('viewer-joined');
      socket.off('viewer-left');
      socket.off('webrtc-answer');
      socket.off('webrtc-ice');
      socket.disconnect();
    };
  }, [roomId, usingBack, createPeerConnection, startRecording, startMotionDetection]);

  // Pause/resume motion detection when toggled without restarting the stream
  useEffect(() => {
    if (!motionEnabled) {
      clearTimeout(motionTimer.current);
      prevFrame.current = null;
      setMotionActive(false);
      motionOnCooldown.current = false;
    } else if (videoRef.current && status === 'Live') {
      startMotionDetection(videoRef.current);
    }
  }, [motionEnabled, status, startMotionDetection]);

  function enterFullscreen() {
    const el = videoRef.current;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
  }

  function toggleMute() {
    const audioTracks = localStream.current?.getAudioTracks() ?? [];
    const next = !isMuted;
    audioTracks.forEach((t) => { t.enabled = !next; });
    setIsMuted(next);
  }

  function copyCode() {
    navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="page">
      <div className="camera-header">
        <div className="room-code">
          Room <strong>{roomId}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={copyCode}>
            {copied ? 'Copied!' : 'Copy Code'}
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setUsingBack((b) => !b)}>
            Flip
          </button>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`preview-video${usingBack ? ' back' : ''}`}
        />
        <button className="video-overlay-btn left" onClick={toggleMute} title={isMuted ? 'Unmute mic' : 'Mute mic'}>
          {isMuted ? '🔇' : '🎙'}
        </button>
        <button className="video-overlay-btn right" onClick={enterFullscreen} title="Fullscreen">⛶</button>
      </div>

      {/* Hidden canvas used for motion detection frame comparison */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <div className="status-row">
        <span className="badge badge-live">
          <span className="dot" /> {status}
        </span>
        {isRecording && (
          <span className="badge badge-rec">
            <span className="dot" /> REC
          </span>
        )}
        {motionActive && (
          <span className="badge badge-motion">
            <span className="dot" /> MOTION
          </span>
        )}
        <span className="badge badge-waiting">
          {viewerCount} viewer{viewerCount !== 1 ? 's' : ''}
        </span>
      </div>

      {gps ? (
        <div className="gps-info">
          <strong>GPS</strong>&nbsp; {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          &nbsp;&nbsp;±{Math.round(gps.accuracy)}m
        </div>
      ) : (
        <div className="gps-info">GPS: waiting for signal...</div>
      )}

      <div className="motion-toggle">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={motionEnabled}
            onChange={(e) => setMotionEnabled(e.target.checked)}
          />
          Motion detection {motionEnabled ? 'on' : 'off'}
          {motionEnabled && motionOnCooldown.current && (
            <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: '0.8rem' }}>
              (cooldown 60s)
            </span>
          )}
        </label>
      </div>

      <button className="btn-danger" onClick={() => navigate('/')}>
        Stop Camera
      </button>

      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', textAlign: 'center' }}>
        Keep this page open. Screen lock may pause streaming on some devices.
      </p>
    </div>
  );
}
