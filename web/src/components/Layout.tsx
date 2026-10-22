// App shell for authenticated pages: sticky header with brand, user email and
// logout; content column below.

import { Link, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Button, focusRing } from './primitives';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            to="/"
            className={`flex items-center gap-2 rounded-lg px-1 py-1 ${focusRing}`}
            aria-label="Interview Prep Kit home"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500/15 text-indigo-300">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-sm font-semibold tracking-tight">Interview Prep Kit</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            {user ? (
              <span className="hidden max-w-[220px] truncate text-xs text-slate-400 sm:block">
                {user.email}
              </span>
            ) : null}
            <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void handleLogout()}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
