import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Camera from './pages/Camera';
import Viewer from './pages/Viewer';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/camera/:roomId" element={<Camera />} />
        <Route path="/viewer/:roomId" element={<Viewer />} />
      </Routes>
    </BrowserRouter>
  );
}
