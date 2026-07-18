import React, { useState } from 'react';
import { requestCode, verifyCode } from '../auth.js';

// Email one-time-code sign-in. Two steps in one card: enter email → Supabase
// emails a 6-digit code → enter it. No passwords, no Google console. Access is
// gated server-side by RLS (authenticated + allow-listed email), so a code for
// a non-allow-listed address signs in but sees an empty/denied board — the UI
// surfaces that as a clear message rather than a silent blank.
export function SignIn() {
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const sendCode = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setErr(null);
    try { await requestCode(email); setStep('code'); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true); setErr(null);
    try { await verifyCode(email, code); /* onAuth flips the gate */ }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="signin-screen">
      <div className="signin-card">
        <div className="signin-brand">
          <h1>Dash</h1>
          <span className="pulse" />
        </div>
        {step === 'email' ? (
          <form onSubmit={sendCode}>
            <p className="signin-lead">Sign in to the board.</p>
            <input
              type="email" autoFocus value={email} disabled={busy}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" aria-label="email"
            />
            <button type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
            <button type="button" className="signin-link" disabled={busy || !email.trim()}
              onClick={() => { setStep('code'); setErr(null); }}>
              I already have a code
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <p className="signin-lead">Enter the code sent to <b>{email}</b>.</p>
            <input
              type="text" inputMode="numeric" autoFocus value={code} disabled={busy}
              onChange={e => setCode(e.target.value)}
              placeholder="6-digit code" aria-label="code"
            />
            <button type="submit" disabled={busy || !code.trim()}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button type="button" className="signin-link" disabled={busy}
              onClick={() => { setStep('email'); setCode(''); setErr(null); }}>
              use a different email
            </button>
          </form>
        )}
        {err ? <p className="signin-err">{err}</p> : null}
      </div>
    </div>
  );
}
