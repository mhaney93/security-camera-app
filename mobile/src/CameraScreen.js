import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform, AppState, SafeAreaView, ScrollView,
} from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission, useMicrophonePermission,
  useFrameProcessor, runAtTargetFps,
} from 'react-native-vision-camera';
import { useSharedValue, useRunOnJS } from 'react-native-worklets-core';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';
import notifee, { AndroidImportance } from '@notifee/react-native';
import { createSocket, createApiFetch } from './socket';
import { MOTION_COOLDOWN_MS, sampleFrame, hasMotion } from './motion';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export default function CameraScreen({ session, onStop }) {
  const { serverUrl, appSecret, roomCode } = session;

  // Refs that must survive re-renders without triggering them
  const cameraRef = useRef(null);
  const socketRef = useRef(null);
  const apiFetchRef = useRef(null);
  const peersRef = useRef({});
  const localStreamRef = useRef(null);
  const isMountedRef = useRef(true);
  const recTimerRef = useRef(null);
  const recordingStartedRef = useRef(false);
  const gpsRef = useRef(null);
  const gpsWatchRef = useRef(null);
  const isMutedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const usingBackRef = useRef(true);
  const motionTimerRef = useRef(null);
  const motionOnCooldownRef = useRef(false);

  const [status, setStatus] = useState('Starting...');
  const [viewerCount, setViewerCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [gps, setGps] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [usingBack, setUsingBack] = useState(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [motionActive, setMotionActive] = useState(false);
  const [motionUnsupported, setMotionUnsupported] = useState(false);

  const { hasPermission: hasCamPerm, requestPermission: reqCamPerm } = useCameraPermission();
  const { hasPermission: hasMicPerm, requestPermission: reqMicPerm } = useMicrophonePermission();
  const device = useCameraDevice(usingBack ? 'back' : 'front');

  // ─── Motion detection: same alert + 60s cooldown as the web camera ──────────
  const handleMotion = useCallback(() => {
    if (!isMountedRef.current || motionOnCooldownRef.current || !socketRef.current) return;
    motionOnCooldownRef.current = true;
    setMotionActive(true);
    socketRef.current.emit('motion-detected', { roomId: roomCode });
    motionTimerRef.current = setTimeout(() => {
      motionOnCooldownRef.current = false;
      setMotionActive(false);
    }, MOTION_COOLDOWN_MS);
  }, [roomCode]);

  const onMotion = useRunOnJS(handleMotion, [handleMotion]);
  const onMotionUnsupported = useRunOnJS(setMotionUnsupported, []);
  const prevSamples = useSharedValue(null);
  const motionEnabledShared = useSharedValue(true);
  const motionUnsupportedShared = useSharedValue(false);

  // Compares a coarse grid of the frame once per second. The frame processor stays
  // attached even when motion is off so toggling never reconfigures the camera
  // session (which would interrupt the in-progress recording segment).
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    runAtTargetFps(1, () => {
      'worklet';
      if (motionUnsupportedShared.value) return;
      if (!motionEnabledShared.value) {
        prevSamples.value = null;
        return;
      }
      let curr;
      try {
        curr = sampleFrame(new Uint8Array(frame.toArrayBuffer()), frame.width, frame.height);
      } catch (e) {
        motionUnsupportedShared.value = true;
        onMotionUnsupported(true);
        return; // pixel access unavailable (e.g. Android < 9) — skip motion detection
      }
      const prev = prevSamples.value;
      if (prev && prev.width === frame.width && prev.height === frame.height && hasMotion(prev.samples, curr)) {
        onMotion();
      }
      prevSamples.value = { width: frame.width, height: frame.height, samples: curr };
    });
  }, [onMotion, onMotionUnsupported, prevSamples, motionEnabledShared, motionUnsupportedShared]);

  // Pause/resume motion detection when toggled without touching the camera session
  useEffect(() => {
    motionEnabledShared.value = motionEnabled;
    if (!motionEnabled) {
      clearTimeout(motionTimerRef.current);
      motionOnCooldownRef.current = false;
      setMotionActive(false);
    }
  }, [motionEnabled, motionEnabledShared]);

  // ─── Upload a recorded video chunk then delete the temp file ────────────────
  const uploadChunk = useCallback(async (filePath) => {
    try {
      const info = await FileSystem.getInfoAsync(filePath);
      if (!info.exists || info.size === 0) return;
      const form = new FormData();
      form.append('chunk', { uri: filePath, type: 'video/mp4', name: 'recording.mp4' });
      if (gpsRef.current) {
        form.append('lat', String(gpsRef.current.latitude));
        form.append('lng', String(gpsRef.current.longitude));
      }
      await apiFetchRef.current(`/api/upload/${roomCode}`, { method: 'POST', body: form });
    } catch { /* ignore upload failures */ }
    try { await FileSystem.deleteAsync(filePath, { idempotent: true }); } catch {}
  }, [roomCode]);

  // ─── Start a recording segment; auto-rotates every 5 minutes ────────────────
  const startRecording = useCallback(() => {
    if (!cameraRef.current || !isMountedRef.current) return;
    clearTimeout(recTimerRef.current);

    cameraRef.current.startRecording({
      onRecordingFinished: async (video) => {
        setIsRecording(false);
        await uploadChunk(video.path);
        if (isMountedRef.current) startRecording();
      },
      onRecordingError: () => {
        setIsRecording(false);
        if (isMountedRef.current) setTimeout(startRecording, 1000);
      },
    });
    setIsRecording(true);

    // Stop after 5 minutes — onRecordingFinished will restart it
    recTimerRef.current = setTimeout(() => {
      cameraRef.current?.stopRecording().catch(() => {});
    }, 5 * 60 * 1000);
  }, [uploadChunk]);

  // ─── Create a WebRTC peer connection for a viewer ────────────────────────────
  const createPeerConnection = useCallback((viewerId) => {
    const socket = socketRef.current;
    const pc = new RTCPeerConnection(ICE_CONFIG);
    peersRef.current[viewerId] = pc;

    localStreamRef.current?.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('webrtc-ice', { candidate, targetId: viewerId });
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        delete peersRef.current[viewerId];
      }
    };
    return pc;
  }, []);

  // ─── Main init: permissions → foreground service → WebRTC → socket ──────────
  useEffect(() => {
    isMountedRef.current = true;

    async function init() {
      // Camera permission
      if (!hasCamPerm) {
        const granted = await reqCamPerm();
        if (!granted) { setStatus('Camera permission denied'); return; }
      }
      if (!hasMicPerm) await reqMicPerm();

      // GPS
      const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
      if (locStatus === 'granted') {
        gpsWatchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
          ({ coords }) => {
            const point = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
            setGps(point);
            gpsRef.current = point;
            socketRef.current?.emit('gps-update', {
              roomId: roomCode,
              lat: coords.latitude,
              lng: coords.longitude,
              accuracy: coords.accuracy,
              timestamp: Date.now(),
            });
          }
        );
      }

      // Foreground Service on Android keeps the process alive when backgrounded/locked
      if (Platform.OS === 'android') {
        await notifee.createChannel({ id: 'rec', name: 'Camera Recording', importance: AndroidImportance.LOW });
        await notifee.displayNotification({
          title: 'ACME Camera',
          body: 'Recording in progress — tap to return',
          android: {
            channelId: 'rec',
            asForegroundService: true,
            importance: AndroidImportance.LOW,
            ongoing: true,
            pressAction: { id: 'default' },
          },
        });
      }

      // Prevent screen from auto-locking
      await activateKeepAwakeAsync();

      // WebRTC: try full video+audio stream first; if the camera is already held by
      // VisionCamera (common on many devices), fall back to audio-only so at least
      // live audio reaches viewers while VisionCamera handles video recording.
      try {
        const stream = await mediaDevices.getUserMedia({
          video: { facingMode: usingBackRef.current ? 'environment' : 'user', width: 1280, height: 720 },
          audio: true,
        });
        stream.getAudioTracks().forEach(t => { t.enabled = false; });
        localStreamRef.current = stream;
      } catch {
        try {
          const audioOnly = await mediaDevices.getUserMedia({ video: false, audio: true });
          audioOnly.getAudioTracks().forEach(t => { t.enabled = false; });
          localStreamRef.current = audioOnly;
        } catch {
          // No WebRTC stream available — recording still works via VisionCamera
        }
      }

      // Socket + signaling
      const socket = createSocket(serverUrl, appSecret);
      const apiFetch = createApiFetch(serverUrl, appSecret);
      socketRef.current = socket;
      apiFetchRef.current = apiFetch;

      socket.connect();
      socket.emit('join-room', { roomId: roomCode, role: 'camera' });

      socket.on('room-joined', ({ viewerCount: vc }) => { setViewerCount(vc); setStatus('Live'); });
      socket.on('viewer-joined', async ({ viewerId }) => {
        if (!isMountedRef.current) return;
        setViewerCount(c => c + 1);
        const pc = createPeerConnection(viewerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { offer, targetId: viewerId });
      });
      socket.on('viewer-left', ({ viewerId }) => {
        setViewerCount(c => Math.max(0, c - 1));
        peersRef.current[viewerId]?.close();
        delete peersRef.current[viewerId];
      });
      socket.on('webrtc-answer', async ({ answer, fromId }) => {
        try { await peersRef.current[fromId]?.setRemoteDescription(answer); } catch {}
      });
      socket.on('webrtc-ice', async ({ candidate, fromId }) => {
        try { await peersRef.current[fromId]?.addIceCandidate(candidate); } catch {}
      });
    }

    init();

    // Re-check recording state when app returns to foreground
    const appStateSub = AppState.addEventListener('change', async (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && prev !== 'active' && isMountedRef.current) {
        await activateKeepAwakeAsync(); // re-request on iOS (auto-released when backgrounded)
        if (!isRecording && cameraRef.current) startRecording();
      }
    });

    return () => {
      isMountedRef.current = false;
      clearTimeout(recTimerRef.current);
      clearTimeout(motionTimerRef.current);
      appStateSub.remove();
      gpsWatchRef.current?.remove();

      try { cameraRef.current?.stopRecording(); } catch {}
      recordingStartedRef.current = false;

      localStreamRef.current?.getTracks().forEach(t => t.stop());
      Object.values(peersRef.current).forEach(pc => pc.close());
      peersRef.current = {};

      socketRef.current?.off('room-joined');
      socketRef.current?.off('viewer-joined');
      socketRef.current?.off('viewer-left');
      socketRef.current?.off('webrtc-answer');
      socketRef.current?.off('webrtc-ice');
      socketRef.current?.disconnect();

      deactivateKeepAwake();
      if (Platform.OS === 'android') notifee.stopForegroundService();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, serverUrl, appSecret]);

  // ─── Camera initialized: kick off the first recording segment ───────────────
  function handleCameraReady() {
    if (recordingStartedRef.current || !isMountedRef.current) return;
    recordingStartedRef.current = true;
    setTimeout(startRecording, 300);
  }

  function toggleMute() {
    const next = !isMuted;
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    isMutedRef.current = next;
    setIsMuted(next);
  }

  function flipCamera() {
    const next = !usingBack;
    usingBackRef.current = next;
    prevSamples.value = null; // don't compare frames across the camera switch
    setUsingBack(next);
  }

  if (!hasCamPerm || !device) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.errorText}>{status}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} bounces={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.roomCode}>
            Room <Text style={styles.roomCodeBold}>{roomCode}</Text>
          </Text>
          <View style={styles.headerBtns}>
            <TouchableOpacity style={styles.btnGhost} onPress={flipCamera}>
              <Text style={styles.btnGhostText}>Flip</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnGhost} onPress={() => setShowSettings(s => !s)}>
              <Text style={styles.btnGhostText}>⚙</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Camera preview */}
        <Camera
          ref={cameraRef}
          style={styles.camera}
          device={device}
          isActive
          video
          audio
          onInitialized={handleCameraReady}
          frameProcessor={frameProcessor}
        />

        {/* Status badges */}
        <View style={styles.statusRow}>
          <View style={styles.badgeLive}>
            <View style={[styles.dot, { backgroundColor: '#00e676' }]} />
            <Text style={styles.badgeLiveText}>{status}</Text>
          </View>
          {isRecording && (
            <View style={styles.badgeRec}>
              <View style={[styles.dot, { backgroundColor: '#ff1744' }]} />
              <Text style={styles.badgeRecText}>REC</Text>
            </View>
          )}
          {motionActive && (
            <View style={styles.badgeMotion}>
              <View style={[styles.dot, { backgroundColor: '#ff6d00' }]} />
              <Text style={styles.badgeMotionText}>MOTION</Text>
            </View>
          )}
          <View style={styles.badgeCount}>
            <Text style={styles.badgeCountText}>{viewerCount} viewer{viewerCount !== 1 ? 's' : ''}</Text>
          </View>
        </View>

        {/* Settings panel */}
        {showSettings && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Settings</Text>
            <TouchableOpacity style={styles.toggleRow} onPress={toggleMute} activeOpacity={0.7}>
              <View style={[styles.checkbox, !isMuted && styles.checkboxOn]}>
                {!isMuted && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.toggleText}>Microphone {isMuted ? 'off' : 'on'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toggleRow} onPress={() => setMotionEnabled(m => !m)} disabled={motionUnsupported} activeOpacity={0.7}>
              <View style={[styles.checkbox, motionEnabled && !motionUnsupported && styles.checkboxOn]}>
                {motionEnabled && !motionUnsupported && <Text style={styles.checkmark}>✓</Text>}
              </View>
              {motionUnsupported ? (
                <Text style={styles.toggleText}>Motion detection unavailable on this device</Text>
              ) : (
                <Text style={styles.toggleText}>
                  Motion detection {motionEnabled ? 'on' : 'off'}
                  {motionEnabled && motionActive && <Text style={styles.toggleHint}>  (cooldown 60s)</Text>}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* GPS */}
        <View style={styles.gpsBox}>
          {gps ? (
            <Text style={styles.gpsText}>
              <Text style={styles.gpsLabel}>GPS  </Text>
              {gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}{'  '}
              ±{Math.round(gps.accuracy)}m
            </Text>
          ) : (
            <Text style={styles.gpsText}>GPS: waiting for signal...</Text>
          )}
        </View>

        {/* Stop */}
        <TouchableOpacity style={styles.btnDanger} onPress={onStop} activeOpacity={0.8}>
          <Text style={styles.btnDangerText}>Stop Camera</Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          Recording continues when the screen is locked or you switch apps.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { padding: 16, gap: 14 },
  errorText: { color: '#888', textAlign: 'center', marginTop: 120, fontSize: 15 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerBtns: { flexDirection: 'row', gap: 8 },
  roomCode: { fontSize: 14, color: '#888' },
  roomCodeBold: { color: '#f0f0f0', letterSpacing: 2, fontWeight: '700', fontSize: 15 },
  btnGhost: { backgroundColor: '#222', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  btnGhostText: { color: '#f0f0f0', fontSize: 13, fontWeight: '600' },

  camera: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  badgeLive: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: '#00e67622' },
  badgeLiveText: { color: '#00e676', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  badgeRec: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: '#ff174422' },
  badgeRecText: { color: '#ff1744', fontSize: 11, fontWeight: '700' },
  badgeMotion: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: '#ff6d0022' },
  badgeMotionText: { color: '#ff6d00', fontSize: 11, fontWeight: '700' },
  badgeCount: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: '#88888822' },
  badgeCountText: { color: '#888', fontSize: 11, fontWeight: '700' },

  card: { backgroundColor: '#161616', borderWidth: 1, borderColor: '#333', borderRadius: 10, padding: 16, gap: 12 },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#f0f0f0' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, borderColor: '#555', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: '#00e676', borderColor: '#00e676' },
  checkmark: { color: '#000', fontSize: 11, fontWeight: '700' },
  toggleText: { color: '#888', fontSize: 14 },
  toggleHint: { color: '#555', fontSize: 12 },

  gpsBox: { backgroundColor: '#161616', borderWidth: 1, borderColor: '#333', borderRadius: 10, padding: 10 },
  gpsText: { color: '#888', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  gpsLabel: { color: '#00e676', fontWeight: '700' },

  btnDanger: { backgroundColor: '#ff1744', borderRadius: 10, padding: 14, alignItems: 'center' },
  btnDangerText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  hint: { color: '#555', fontSize: 12, textAlign: 'center', paddingBottom: 8 },
});
