/** Release number and commit of this build, shown in the footer. Set by vite.config.ts at build time. */
export const APP_VERSION = __APP_VERSION__;
export const GIT_SHA = __GIT_SHA__;
export const REPO_URL = 'https://github.com/aih/wa-leg';
export const RELEASE_URL = `${REPO_URL}/releases/tag/v${APP_VERSION}`;
export const COMMIT_URL = GIT_SHA === 'unknown' ? REPO_URL : `${REPO_URL}/commit/${GIT_SHA}`;
