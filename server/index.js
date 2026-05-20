require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { initDb, saveGpsPoint, getGpsHistory, saveRecording, getRecordings, getExpiredRecordings, deleteExpiredRecordings, deleteExpiredGps } = require('./db');
const { storeRecording, streamRecording, deleteRecording, uploadsDir, USE_R2 } = require('./storage');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json());

const APP_SECRET = process.env.APP_SECRET;

// Guard all /api routes when APP_SECRET is set
app.use('/api', (req, res, next) => {
  if (!APP_SECRET) return next();
  if (req.headers['x-app-secret'] === APP_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// Guard socket connections when APP_SECRET is set
io.use((socket, next) => {
  if (!APP_SECRET) return next();
  if (socket.handshake.auth?.secret === APP_SECRET) return next();
  next(new Error('Unauthorized'));
});

// Multer saves to uploads/ first; storeRecording() then forwards to R2 if configured
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.webm`),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

// --- Privacy Policy ---
app.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy – ACME Camera</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.6; }
    h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
    p, li { font-size: 0.97rem; } ul { padding-left: 1.4rem; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>ACME Camera</strong> &mdash; Last updated: May 20, 2026</p>

  <h2>What we collect</h2>
  <ul>
    <li><strong>Camera &amp; microphone</strong>: video and audio are streamed and optionally recorded while the app is in use. Recordings are stored on the server you connect to and are deleted automatically after 48 hours.</li>
    <li><strong>Location</strong>: GPS coordinates are logged while the camera is active, stored on the server, and deleted automatically after 7 days. Location is never shared with third parties.</li>
  </ul>

  <h2>What we do not collect</h2>
  <ul>
    <li>We do not collect your name, email address, or any account information.</li>
    <li>We do not use analytics, advertising, or tracking SDKs.</li>
    <li>We do not sell or share your data with any third party.</li>
  </ul>

  <h2>Data storage</h2>
  <p>Recordings and GPS logs are stored on a private server. All data is transmitted over HTTPS. Recordings are automatically deleted after 48 hours; GPS logs after 7 days.</p>

  <h2>Permissions</h2>
  <ul>
    <li><strong>Camera</strong>: required to capture and stream video.</li>
    <li><strong>Microphone</strong>: required to capture and stream audio alongside video.</li>
    <li><strong>Location</strong>: used to tag recordings with GPS coordinates.</li>
  </ul>

  <h2>Contact</h2>
  <p>Questions? Email <a href="mailto:matthew.haney1993@gmail.com">matthew.haney1993@gmail.com</a></p>
</body>
</html>`);
});

// Recordings file streaming — uses query param secret because browsers can't
// send custom headers for <video src> requests.
app.get('/api/recordings/file/:key', async (req, res) => {
  if (APP_SECRET && req.query.secret !== APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await streamRecording(path.basename(req.params.key), req, res);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- REST API ---

app.post('/api/upload/:roomId', upload.single('chunk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const lat = req.body.lat ? parseFloat(req.body.lat) : null;
    const lng = req.body.lng ? parseFloat(req.body.lng) : null;
    await storeRecording(req.file.path, req.file.filename);
    await saveRecording(req.params.roomId, req.file.filename, Date.now(), lat, lng);
    res.json({ ok: true });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/recordings/:roomId', async (req, res) => {
  try {
    res.json(await getRecordings(req.params.roomId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/gps/:roomId', async (req, res) => {
  try {
    res.json(await getGpsHistory(req.params.roomId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:roomId/exists', async (req, res) => {
  const { roomId } = req.params;
  if (rooms.get(roomId)?.cameraId) return res.json({ exists: true });
  try {
    const [recs, gps] = await Promise.all([getRecordings(roomId), getGpsHistory(roomId)]);
    res.json({ exists: recs.length > 0 || gps.length > 0 });
  } catch {
    res.json({ exists: false });
  }
});

// Serve built client in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// --- Socket.io rooms ---
// rooms: Map<roomId, { cameraId: string|null, viewers: Set<string> }>
const rooms = new Map();
// Tracks rooms that recently sent a motion notification (prevents spam)
const motionCooldowns = new Map();

async function sendMotionNotification(roomId) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  if (motionCooldowns.has(roomId)) return;

  motionCooldowns.set(roomId, true);
  setTimeout(() => motionCooldowns.delete(roomId), 60 * 1000);

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title': 'Motion Detected',
        'Priority': 'high',
        'Tags': 'rotating_light',
        'Content-Type': 'text/plain',
      },
      body: `Motion detected in room ${roomId}`,
    });
  } catch (err) {
    console.error('ntfy notification failed:', err.message);
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { cameraId: null, viewers: new Set() });
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);
    const room = getOrCreateRoom(roomId);

    if (role === 'camera') {
      room.cameraId = socket.id;
      socket.emit('room-joined', { role, viewerCount: room.viewers.size });
      // Re-offer to any viewers already waiting
      room.viewers.forEach((viewerId) => io.to(socket.id).emit('viewer-joined', { viewerId }));
    } else {
      room.viewers.add(socket.id);
      socket.emit('room-joined', { role, hasCamera: !!room.cameraId });
      if (room.cameraId) io.to(room.cameraId).emit('viewer-joined', { viewerId: socket.id });
    }
  });

  // WebRTC signaling — server relays blindly, never inspects content
  socket.on('webrtc-offer',  ({ offer,     targetId }) => io.to(targetId).emit('webrtc-offer',  { offer,     fromId: socket.id }));
  socket.on('webrtc-answer', ({ answer,    targetId }) => io.to(targetId).emit('webrtc-answer', { answer,    fromId: socket.id }));
  socket.on('webrtc-ice',    ({ candidate, targetId }) => io.to(targetId).emit('webrtc-ice',    { candidate, fromId: socket.id }));

  // Motion detection — relay to viewers + push notification via ntfy
  socket.on('motion-detected', ({ roomId }) => {
    socket.to(roomId).emit('motion-detected');
    sendMotionNotification(roomId).catch(console.error);
  });

  // GPS relay + persist
  socket.on('gps-update', ({ roomId, lat, lng, accuracy, timestamp }) => {
    saveGpsPoint(roomId, lat, lng, accuracy ?? null, timestamp).catch(console.error);
    socket.to(roomId).emit('gps-update', { lat, lng, accuracy, timestamp });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (!rooms.has(roomId)) continue;
      const room = rooms.get(roomId);
      if (room.cameraId === socket.id) {
        room.cameraId = null;
        socket.to(roomId).emit('camera-disconnected');
      } else {
        room.viewers.delete(socket.id);
        if (room.cameraId) io.to(room.cameraId).emit('viewer-left', { viewerId: socket.id });
      }
    }
  });
});

const RECORDING_RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours
const GPS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

async function cleanupOldRecordings() {
  const cutoff = Date.now() - RECORDING_RETENTION_MS;
  try {
    const expired = await getExpiredRecordings(cutoff);
    if (expired.length === 0) return;
    await Promise.allSettled(expired.map((r) => deleteRecording(r.filename)));
    await deleteExpiredRecordings(cutoff);
    console.log(`Cleanup: removed ${expired.length} recording(s) older than 48h`);
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

async function cleanupOldGps() {
  const cutoff = Date.now() - GPS_RETENTION_MS;
  try {
    await deleteExpiredGps(cutoff);
  } catch (err) {
    console.error('GPS cleanup error:', err.message);
  }
}

async function start() {
  await initDb();
  const storageMode = USE_R2 ? 'Cloudflare R2' : 'local disk';
  const dbMode = process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite';
  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () =>
    console.log(`SecureCam on http://localhost:${PORT}  [db: ${dbMode}] [storage: ${storageMode}]`)
  );

  // Run cleanup immediately on boot, then every hour
  cleanupOldRecordings();
  cleanupOldGps();
  setInterval(cleanupOldRecordings, 60 * 60 * 1000);
  setInterval(cleanupOldGps, 60 * 60 * 1000);
}

start().catch(console.error);
