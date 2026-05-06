import { io } from 'socket.io-client';

const URL = import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;

export const socket = io(URL, {
  autoConnect: false,
  auth: (cb) => cb({ secret: sessionStorage.getItem('app_secret') ?? '' }),
});

export function apiFetch(url, options = {}) {
  const secret = sessionStorage.getItem('app_secret') ?? '';
  return fetch(url, {
    ...options,
    headers: { 'x-app-secret': secret, ...(options.headers ?? {}) },
  });
}
