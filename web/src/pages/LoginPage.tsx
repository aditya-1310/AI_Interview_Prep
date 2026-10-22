// Email + password sign-in with inline validation and a server error banner.

import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { errMessage } from '../api/client';
import { Button, ErrorBanner, Field, TextInput } from '../components/primitives';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-500/15 text-indigo-300">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-xs uppercase tracking-widest text-slate-500">Interview Prep Kit</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 sm:p-8">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-4 text-center text-sm text-slate-400">{footer}</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const next: { email?: string; password?: string } = {};
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length === 0) next.password = 'Enter your password.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const user = await login(email.trim(), password);
      if (user) {
        navigate(from, { replace: true });
      } else {
        setServerError('Signed in, but the session could not be confirmed. Try again.');
      }
    } catch (err) {
      setServerError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your prep kits."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="text-indigo-300 underline-offset-2 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)} noValidate>
        {serverError ? <ErrorBanner message={serverError} /> : null}
        <Field id="login-email" label="Email" error={errors.email}>
          <TextInput
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field id="login-password" label="Password" error={errors.password}>
          <TextInput
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            required
          />
        </Field>
        <Button type="submit" pending={submitting} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
