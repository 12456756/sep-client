/**
 * Login Page
 *
 * Email + password login with device fingerprint
 */

import React, { useState } from 'react';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

interface LoginPageProps {
  onLoginSuccess: (data: {
    accessToken: string;
    expiresIn: number;
    user: { id: string; email: string; name: string };
    enterprise: { id: string; name: string } | null;
  }) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await window.electronAPI.login({ email, password });

      if (result.success && result.data) {
        onLoginSuccess(result.data);
      } else {
        setError(result.error?.message || 'Login failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Development: quick fill test account.
  // Credentials come from .env.local (gitignored) — never hardcode them here.
  //   VITE_SEP_TEST_EMAIL / VITE_SEP_TEST_PASSWORD
  const testEmail = import.meta.env['VITE_SEP_TEST_EMAIL'] ?? '';
  const testPassword = import.meta.env['VITE_SEP_TEST_PASSWORD'] ?? '';
  const hasTestAccount = testEmail !== '' && testPassword !== '';

  const fillTestAccount = () => {
    setEmail(testEmail);
    setPassword(testPassword);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          {/* Logo / Title */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              SEP Client
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Sign in to your account
            </p>
          </div>

          {/* Error Alert */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="Email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              autoComplete="email"
              autoFocus
            />

            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              autoComplete="current-password"
            />

            <Button
              type="submit"
              variant="primary"
              loading={loading}
              disabled={loading}
              className="w-full"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>

          {/* Development Helper — only when test credentials are configured */}
          {process.env.NODE_ENV === 'development' && hasTestAccount && (
            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <Button
                variant="ghost"
                onClick={fillTestAccount}
                className="w-full text-sm"
                disabled={loading}
              >
                Use test account
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-gray-500 dark:text-gray-400">
          SEP Client v1.0.0 • Powered by pi-coding-agent
        </p>
      </div>
    </div>
  );
};
