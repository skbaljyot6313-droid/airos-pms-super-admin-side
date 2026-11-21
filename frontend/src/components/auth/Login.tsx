import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { BackButton } from '../ui/BackButton';
import { FormField } from './FormField';
import { PasswordInput } from './PasswordInput';
import * as authApi from '../../api/auth';
import { ApiError } from '../../api/client';

export const Login: React.FC = () => {
  const { signIn, navigate, isAuthenticated, currentUser } = useApp();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [resetNote, setResetNote] = useState(false);

  // Already signed in → send to the role's workspace
  if (isAuthenticated && currentUser) {
    if (currentUser.role === 'super_admin') return <Navigate to="/admin/properties" replace />;
    if (currentUser.role === 'property_manager')
      return <Navigate to={`/property/${currentUser.property_uid}/overview`} replace />;
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return; // prevent duplicate submissions
    setError(null);

    if (!identifier.trim() || !password) {
      setError('Enter your email/username and password to continue.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await authApi.login({ identifier: identifier.trim(), password });
      signIn({ user: res.user, company: res.company });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Something went wrong while signing in. Please try again.'
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <BackButton to="/" label="Back to home" />
        </div>
        {/* Logo & Headline */}
        <div className="text-center mb-7">
          <div className="inline-flex w-12 h-12 rounded-[14px] bg-[#800020] text-white items-center justify-center font-display font-bold text-xl mb-3 shadow-xs">
            MT
          </div>
          <h1 className="font-display font-bold text-2xl sm:text-[28px] text-[#0D1C42] tracking-tight">
            Welcome back
          </h1>
          <p className="font-body text-sm text-[#667085] mt-1.5">
            Sign in to access your operations workspace.
          </p>
        </div>

        {/* Auth Card */}
        <Card className="p-7 shadow-[0_4px_24px_rgba(0,0,0,0.04)] border-[#E7E5E4]">
          {error && (
            <div
              role="alert"
              className="mb-5 p-3 rounded-[10px] bg-[#FAEBEB] border border-[#F0C8C8] text-[#A83434] text-xs font-medium"
            >
              {error}
            </div>
          )}
          {resetNote && (
            <div className="mb-5 p-3 rounded-[10px] bg-[#EAF1FB] border border-[#C3D6F0] text-[#2457A8] text-xs font-medium">
              Password resets are handled by your company's Super Admin.
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <FormField
                id="login-identifier"
                label="Email or Username"
                value={identifier}
                onChange={setIdentifier}
                placeholder="Enter your email or username"
                autoComplete="username"
              />

              <PasswordInput
                id="login-password"
                label="Password"
                value={password}
                onChange={setPassword}
                placeholder="Enter your password"
                autoComplete="current-password"
                labelAction={
                  <button
                    type="button"
                    onClick={() => setResetNote((v) => !v)}
                    className="text-xs text-[#800020] hover:underline cursor-pointer normal-case tracking-normal"
                  >
                    Forgot password?
                  </button>
                }
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full mt-5 font-semibold"
              isLoading={isLoading}
              disabled={isLoading}
            >
              Login
            </Button>
          </form>
        </Card>

        {/* Switch to Signup */}
        <p className="text-center text-sm text-[#667085] mt-5 font-body">
          Don't have an account?{' '}
          <button
            onClick={() => navigate('/signup')}
            className="text-[#800020] font-medium hover:underline cursor-pointer"
          >
            Create your company
          </button>
        </p>
      </div>
    </div>
  );
};
