require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { initDb, saveGpsPoint, getGpsHistory, saveRecording, getRecordings, getExpiredRecordings, deleteExpiredRecordings } = require('./db');
const { storeRecording, streamRecording, deleteRecording, uploadsDir, USE_R2 } = require('./storage');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json());

// Multer saves to uploads/ first; storeRecording() then forwards to R2 if configured
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.webm`),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

// --- REST API ---

app.post('/api/upload/:roomId', upload.single('chunk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    await storeRecording(req.file.path, req.file.filename);
    await saveRecording(req.params.roomId, req.file.filename, Date.now());
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

app.get('/api/recordings/file/:key', async (req, res) => {
  try {
    await streamRecording(path.basename(req.params.key), req, res);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/gps/:roomId', async (req, res) => {
  try {
    res.json(await getGpsHistory(req.params.roomId));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      body: `Motion detected in room ${roomId} at ${new Date().toLocaleString()}`,
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

const RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours

async function cleanupOldRecordings() {
  const cutoff = Date.now() - RETENTION_MS;
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
  setInterval(cleanupOldRecordings, 60 * 60 * 1000);
}

start().catch(console.error);
