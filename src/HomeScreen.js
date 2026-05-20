import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, SafeAreaView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = { serverUrl: 'serverUrl', appSecret: 'appSecret' };

export default function HomeScreen({ onStart }) {
  const [serverUrl, setServerUrl] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [roomCode, setRoomCode] = useState('');

  useEffect(() => {
    AsyncStorage.multiGet([KEYS.serverUrl, KEYS.appSecret]).then((pairs) => {
      if (pairs[0][1]) setServerUrl(pairs[0][1]);
      if (pairs[1][1]) setAppSecret(pairs[1][1]);
    });
  }, []);

  function handleStart() {
    const url = serverUrl.trim().replace(/\/$/, '');
    const secret = appSecret.trim();
    const code = roomCode.trim().toUpperCase();
    if (!url || !secret || !code) return;
    AsyncStorage.multiSet([[KEYS.serverUrl, url], [KEYS.appSecret, secret]]);
    onStart({ serverUrl: url, appSecret: secret, roomCode: code });
  }

  const ready = serverUrl.trim() && appSecret.trim() && roomCode.trim();

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>ACME</Text>
          <Text style={styles.subtitle}>Camera Device</Text>

          <View style={styles.card}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://your-server.onrender.com"
              placeholderTextColor="#555"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            <Text style={styles.label}>App Secret</Text>
            <TextInput
              style={styles.input}
              value={appSecret}
              onChangeText={setAppSecret}
              placeholder="App password"
              placeholderTextColor="#555"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.label}>Room Code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={roomCode}
              onChangeText={(t) => setRoomCode(t.toUpperCase())}
              placeholder="ENTER CODE"
              placeholderTextColor="#555"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
            />

            <TouchableOpacity
              style={[styles.btnPrimary, !ready && styles.btnDisabled]}
              onPress={handleStart}
              activeOpacity={0.8}
              disabled={!ready}
            >
              <Text style={styles.btnPrimaryText}>Start Camera</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.hint}>
            Server URL and secret are saved automatically.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0a0a0a' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: 16, justifyContent: 'center', gap: 16 },
  title: { fontSize: 36, fontWeight: '700', color: '#f0f0f0', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 4 },
  card: {
    backgroundColor: '#161616', borderWidth: 1, borderColor: '#333',
    borderRadius: 10, padding: 20, gap: 10, marginTop: 8,
  },
  label: { fontSize: 13, color: '#888', fontWeight: '500' },
  input: {
    backgroundColor: '#222', borderWidth: 1, borderColor: '#333',
    borderRadius: 10, padding: 14, fontSize: 16, color: '#f0f0f0',
  },
  codeInput: { letterSpacing: 3 },
  btnPrimary: {
    backgroundColor: '#00e676', borderRadius: 10,
    padding: 14, alignItems: 'center', marginTop: 4,
  },
  btnDisabled: { opacity: 0.4 },
  btnPrimaryText: { color: '#000', fontWeight: '700', fontSize: 16 },
  hint: { color: '#555', fontSize: 12, textAlign: 'center' },
});
