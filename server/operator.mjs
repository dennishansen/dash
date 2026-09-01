// WHO is running this computer, and WHICH computer it is.
//
// The dash server has no browser session to ask — it is a local process — but
// plenty of facts it records belong to a person: who filed an issue from the
// CLI, and (now) whose machine a chat lives on. That person is the OPERATOR: the
// git identity configured on this machine, validated against the Dash
// allow-list, so it is the same notion of a person as `issues.owner`, the owner
// picker and every avatar. There is exactly one identity concept in the dash and
// this reads it — it does not invent a second one.
//
// Deterministic, never a guess: `git config user.email`, checked against the
// roster. An address that isn't on the roster resolves to nothing rather than
// being recorded as a person who doesn't exist.

import { execFileSync } from 'child_process';
import os from 'os';
import { listPeople, normalizeEmail } from './profiles-store.mjs';

function gitEmail() {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// This computer's name, as a person would recognise it — what "whose machine is
// that chat on" answers with. hostname() is stable per machine and needs no
// configuration; the trailing `.local` macOS appends is noise, so it comes off.
export function machineName() {
  return String(os.hostname() || '').replace(/\.local$/i, '') || 'this computer';
}

// The operator's allow-listed email, or null when there isn't one (no git
// identity, an address nobody on the board recognises, or the roster is
// unreachable). NEVER throws: the callers that stamp ownership must not fail an
// otherwise-good action because identity couldn't be resolved — an unstamped
// chat degrades to "no owner shown", which is honest.
export async function operatorEmail() {
  const raw = gitEmail();
  if (!raw) return null;
  const email = normalizeEmail(raw);
  try {
    const people = await listPeople();
    return people.some((p) => normalizeEmail(p.email) === email) ? email : null;
  } catch { return null; }
}

// Who owns a CLI-created issue. Every issue must land with a REAL human owner —
// even when an AI files and runs it — so the board never shows orphan work.
// An explicit --owner wins; otherwise the operator. Unlike operatorEmail this
// DOES throw, because creating an orphan row is worse than refusing: the caller
// gets an actionable message telling it to pass --owner. '-' opts out (null).
export async function resolveCliOwner(explicit) {
  if (explicit === '-') return null;
  const raw = explicit || gitEmail();
  if (!raw) {
    throw new Error('no owner to assign — pass --owner <email> or set `git config user.email`.');
  }
  const email = normalizeEmail(raw);
  const people = await listPeople();
  if (!people.some((p) => normalizeEmail(p.email) === email)) {
    const known = people.map((p) => p.email).join(', ') || '(none)';
    throw new Error(`owner "${raw}" isn't on the Dash allow-list. Pass --owner <allow-listed email>. Known: ${known}`);
  }
  return email;
}
