import path from 'node:path';

export const RUN_SCOPED_TEST_TABLES = Object.freeze({
  ARTIFACT_ISSUES_TABLE: 'dash_test_issues',
  ARTIFACT_PROFILES_TABLE: 'dash_test_profiles',
  ARTIFACT_CHATS_TABLE: 'dash_test_chats',
});

export const RUN_OWNED_RESOURCE_DIRS = Object.freeze({
  LAB_CODEX_SESSIONS_DIR: 'codex-sessions',
  LAB_CLAUDE_PROJECTS_DIR: 'claude-projects',
  LAB_CLAUDE_CONTEXT_DIR: 'claude-context',
  LAB_CHAT_REGISTRY_DIR: 'chat-registry',
  LAB_MAIN_CHATS_DIR: 'main-chats',
  // The deployed dash shell is machine state too: a run-owned (empty) release
  // store is what makes a harness-spawned edge serve the BRANCH's dev shell
  // rather than whatever bundle the box happens to have deployed — which is
  // the only thing a test on a branch can honestly be testing.
  LAB_DASH_RELEASES_DIR: 'dash-releases',
});

// Verification brokers choose the persistence namespace; caller environment
// cannot redirect a child back to production or a retired shared clone.
export function withRunScopedTestStores(env = {}) {
  return { ...env, ...RUN_SCOPED_TEST_TABLES };
}

// A durable run owns filesystem state as well as database rows. Every brokered
// child receives the same paths, so a nested Dash runner joins the namespace
// instead of falling back to machine-global transcript, registry, or debug
// files. Callers may preselect a path; a detached root clears inherited values
// before invoking this helper and therefore mints a fresh tree.
export function withRunOwnedTestResources(env = {}, testTmp = env.ARTIFACT_TEST_TMP) {
  if (!testTmp) throw new Error('run-owned test resources require ARTIFACT_TEST_TMP');
  const owned = { ...env, ARTIFACT_TEST_TMP: testTmp };
  for (const [key, relative] of Object.entries(RUN_OWNED_RESOURCE_DIRS)) {
    if (!owned[key]) owned[key] = path.join(testTmp, relative);
  }
  if (!owned.ARTIFACT_DEBUG_FILE) {
    owned.ARTIFACT_DEBUG_FILE = path.join(testTmp, 'artifact-debug.json');
  }
  return owned;
}
