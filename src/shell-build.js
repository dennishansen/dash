// WHICH DASH AM I LOOKING AT — and does it still match the machine's control
// plane?
//
// On the box the dash shell is a RELEASE: a built bundle swapped in by
// `npm run dash:deploy` and picked up only when a browser refreshes
// (dash/server/shell-release.mjs). That is the point — main's merges stop
// reloading the UI mid-use — but it also means the page in front of you can be
// older, or newer, than the supervisor answering its /api/dash calls. A
// mismatch there is not a subtle degradation; it is the protocol the two sides
// speak. The browser surfaces that disagreement while the separate edge↔plane
// boundary refuses a stale supervisor process. Without a word on screen, an
// incompatible UI reads like an unexplained bug.
//
// So the bundle carries its own identity, baked at build time by the app-dev
// factory, and compares it against what the control plane reports.

import { useFetch } from './api.js';
import { RESTART_COMMAND } from './control-plane.js';
import { DASH_BASENAME } from './routes.mjs';

// { id, commit, protocolVersion, builtAt } — `id` names a machine deployment.
// `import.meta.env.DEV` distinguishes a live Vite shell from a static host such
// as Vercel, which has no machine release id but must never call itself live dev.
const SHELL_BUILD = __DASH_SHELL_BUILD__;
const IS_RELEASE = !!SHELL_BUILD?.id;
const IS_DEV = import.meta.env?.DEV === true;

function commitLabel() {
  const [sha, dirty] = String(SHELL_BUILD?.commit || 'unknown').split('-');
  return `${sha.slice(0, 7)}${dirty ? '+' : ''}`;
}

// What the badge says. The commit is the part a human compares against `git
// log`; the release id and build time are the tooltip's job. A shell built from
// a dirty tree says so — codeVersion() suffixes the sha — because "the deploy
// matches this commit" would be a lie about a build nobody can reproduce.
export function shellLabel({ release = IS_RELEASE, dev = IS_DEV } = {}) {
  const kind = release ? 'deploy' : (dev ? 'dev' : 'build');
  return `${kind} ${commitLabel()}`;
}

// The tooltip: everything the badge left out.
export function shellDetail({ release = IS_RELEASE, dev = IS_DEV } = {}) {
  if (release) {
    return [
      `release ${SHELL_BUILD.id}`,
      `commit ${SHELL_BUILD.commit}`,
      `built ${new Date(SHELL_BUILD.builtAt).toLocaleString()}`,
      'refresh to pick up a newer deploy',
    ].join('\n');
  }
  if (dev) {
    return [
      'dash/src is being served from this checkout by vite',
      `commit ${SHELL_BUILD.commit}`,
      'this shell reloads when its source changes',
    ].join('\n');
  }
  return [
    'dash is served as a static build',
    `commit ${SHELL_BUILD.commit}`,
    `built ${new Date(SHELL_BUILD.builtAt).toLocaleString()}`,
    'redeploy its host to pick up source changes',
  ].join('\n');
}

// The live control plane's identity, re-read every few minutes so a supervisor
// restarted from newer main surfaces in an ALREADY-OPEN tab — which is exactly
// when this matters, since the deployed shell deliberately never reloads
// itself.
function useSupervisorIdentity() {
  const { data } = useFetch('/api/dash/supervisor', { pollMs: 300000 });
  return data && data.service === 'artifact-dash-supervisor' ? data : null;
}

// null when the two agree or one is unknown; otherwise which side is behind.
// Only the PROTOCOL is compared. Commits differ constantly by design — the box
// merges main all day and the shell is deliberately not redeployed for every
// merge — so a commit difference is normal operation, not a warning.
//
// A DECLARED mismatch is one of the two ways the plane can be unusable, and it
// only fires when somebody remembered to bump the constant. The other way is
// OBSERVED — a route this board needs that the running build simply does not
// have — and needs no discipline at all (control-plane.js). Both surface
// through the one banner in main.jsx.
export function useShellSkew() {
  const plane = useSupervisorIdentity();
  const mine = SHELL_BUILD?.protocolVersion;
  if (!plane || mine == null || plane.protocolVersion == null) return null;
  if (plane.protocolVersion === mine) return null;
  return {
    shell: mine,
    plane: plane.protocolVersion,
    behind: mine < plane.protocolVersion,
  };
}

// IS A NEWER DEPLOY WAITING FOR THIS TAB? The deployed shell never reloads
// itself — that is the whole point of making it a release — but the cost is a
// tab left open across a deploy that silently keeps serving the bundle it
// booted with, with nothing on screen saying so. The badge above already tells
// you to "refresh to pick up a newer deploy"; it just never knew whether there
// WAS one.
//
// This is a fact, not a guess, and that distinction is the reason it can drive
// a button. The edge resolves the `current` symlink per request, so
// /dash/release.json always names the release a refresh WOULD land on. Two ids,
// both minted by the same deploy, compared for equality: different id ⇒ there
// is something else to get. No timestamps, no heuristics, no polling for
// "probably".
//
// Deliberately the release id and NOT the commit — the same reason useShellSkew
// refuses to compare commits. The box merges main all day without redeploying,
// so a commit difference is normal operation; a release id only changes when
// somebody actually published a new shell.
export function newerDeployId(live, { release = IS_RELEASE, mine = SHELL_BUILD?.id } = {}) {
  if (!release || !mine || !live) return null;
  return live === mine ? null : live;
}

// Release-only, and it does not merely hide in the other modes — it never asks.
// A vite dev shell reloads itself on source change and a static build has no
// release id to compare against, so neither has the question; both pass a null
// url, which useFetch holds still on rather than polling.
export function useNewerDeploy({ release = IS_RELEASE } = {}) {
  const { data } = useFetch(release ? `${DASH_BASENAME}/release.json` : null, { pollMs: 60000 });
  return newerDeployId(data?.id, { release });
}

export function skewNotice(skew, { release = IS_RELEASE, dev = IS_DEV } = {}) {
  if (!skew) return null;
  const subject = release ? 'dash deploy' : (dev ? 'worktree dash' : 'static dash build');
  const behind = skew.behind;
  let remedyLead;
  let remedy;
  if (release && behind) {
    remedyLead = 'Redeploy the shell, then refresh:';
    remedy = 'npm run dash:deploy';
  } else if (release) {
    remedyLead = 'Restart the supervisor from current main, then refresh:';
    remedy = RESTART_COMMAND;
  } else if (!dev) {
    remedyLead = 'Redeploy this static host with matching control-plane settings:';
    remedy = 'redeploy this host';
  } else if (behind) {
    remedyLead = 'Update this worktree, restart its dev server, then refresh:';
    remedy = 'git merge main';
  } else {
    remedyLead = 'Test this branch with its own control plane:';
    remedy = 'node dash/test.mjs --server-only';
  }
  return {
    headline: `This ${subject} is ${behind ? 'older' : 'newer'} than the control plane.`,
    detail: `The shell speaks /api/dash protocol ${skew.shell}, the supervisor speaks ${skew.plane}.`,
    remedyLead,
    remedy,
  };
}
