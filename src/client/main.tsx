import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { Home } from './pages/Home';
import { Join } from './pages/Join';
import { Play } from './pages/Play';
import { Projector } from './pages/Projector';
import { Gallery } from './pages/Gallery';
import { HostLogin, HostDashboard } from './pages/Host';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/e/:code" element={<Join />} />
        <Route path="/e/:code/play" element={<Play />} />
        <Route path="/e/:code/gallery" element={<Gallery />} />
        <Route path="/e/:code/screen" element={<Projector />} />
        <Route path="/host" element={<HostLogin />} />
        <Route path="/host/:code" element={<HostDashboard />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
