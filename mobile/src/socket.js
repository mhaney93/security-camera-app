import { io } from 'socket.io-client';

export function createSocket(serverUrl, appSecret) {
  return io(serverUrl, {
    autoConnect: false,
    auth: { secret: appSecret },
  });
}

export function createApiFetch(serverUrl, appSecret) {
  return (path, options = {}) =>
    fetch(`${serverUrl}${path}`, {
      ...options,
      headers: {
        'x-app-secret': appSecret,
        ...(options.headers ?? {}),
      },
    });
}
