import React, { useState } from 'react';
import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import HomeScreen from './src/HomeScreen';
import CameraScreen from './src/CameraScreen';

// Must be registered before the app renders so Android can find the handler
// when it restarts the foreground service after the app is killed.
if (Platform.OS === 'android') {
  notifee.registerForegroundService(() => new Promise(() => {}));
}

export default function App() {
  const [session, setSession] = useState(null);

  if (session) {
    return <CameraScreen session={session} onStop={() => setSession(null)} />;
  }
  return <HomeScreen onStart={setSession} />;
}
