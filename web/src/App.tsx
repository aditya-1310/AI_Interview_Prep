// App shell: router, toast provider, auth provider, and the global 401
// UNAUTHENTICATED → /login redirect wired through the API client.

import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AnonymousOnly, AuthProvider, ProtectedRoute } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ToastContext';
import { setUnauthorizedHandler } from './api/client';
import DashboardPage from './pages/DashboardPage';
import KitBuilderPage from './pages/KitBuilderPage';
import LoginPage from './pages/LoginPage';
import PracticePage from './pages/PracticePage';
import RegisterPage from './pages/RegisterPage';

function AppRoutes() {
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => navigate('/login', { replace: true }));
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <AnonymousOnly>
            <LoginPage />
          </AnonymousOnly>
        }
      />
      <Route
        path="/register"
        element={
          <AnonymousOnly>
            <RegisterPage />
          </AnonymousOnly>
        }
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/kits/:id" element={<KitBuilderPage />} />
          <Route path="/kits/:id/practice" element={<PracticePage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
