// Release number (root package.json) and commit hash (GIT_SHA, set by the image build) for /health and the OpenAPI document.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.js';

export const APP_VERSION: string = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
export const GIT_SHA: string = (process.env.GIT_SHA ?? 'unknown').slice(0, 7);
