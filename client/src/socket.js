import { io } from 'socket.io-client';

// In dev, Vite proxy forwards /socket.io to localhost:3001.
// In production, server and client share the same origin.
const URL = import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;

export const socket = io(URL, { autoConnect: false });
