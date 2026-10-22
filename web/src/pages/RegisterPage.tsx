// Account creation with inline validation (email format, password length)
// and a server error banner.

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errMessage } from '../api/client';
import { Button, ErrorBanner, Field, TextInput } from '../components/primitives';
import { AuthShell } from './LoginPage';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const next: { email?: string; password?: string } = {};
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD) {
      next.password = `Use at least ${MIN_PASSWORD} characters.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const user = await register(email.trim(), password);
      if (user) {
        navigate('/', { replace: true });
      } else {
        setServerError('Account created, but auto sign-in failed. Please sign in.');
        navigate('/login', { replace: true });
      }
    } catch (err) {
      setServerError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="One account keeps all your prep kits."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-indigo-300 underline-offset-2 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)} noValidate>
        {serverError ? <ErrorBanner message={serverError} /> : null}
        <Field id="register-email" label="Email" error={errors.email}>
          <TextInput
            id="register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field
          id="register-password"
          label="Password"
          error={errors.password}
          hint={`At least ${MIN_PASSWORD} characters.`}
        >
          <TextInput
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Choose a password"
            required
          />
        </Field>
        <Button type="submit" pending={submitting} className="w-full">
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
