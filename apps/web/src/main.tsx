import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { Layout } from "./Layout";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { LibraryPage } from "./pages/Library";
import { GamePage } from "./pages/Game";
import { PlayPage } from "./pages/Play";
import { ResultsPage } from "./pages/Results";
import { AdminPage } from "./pages/Admin";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<RequireAuth><LibraryPage /></RequireAuth>} />
            <Route path="/games/:gameId" element={<RequireAuth><GamePage /></RequireAuth>} />
            <Route path="/games/:gameId/results" element={<RequireAuth><ResultsPage /></RequireAuth>} />
            <Route path="/admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
          </Route>
          {/* The player gets the full window, without the site header. */}
          <Route path="/play/:gameId/:slot" element={<RequireAuth><PlayPage /></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
