import type { WorkflowState } from '@wa-leg/workflow-machine';

/** The four test users the development sign-in page offers. */
export interface DemoUser {
  name: string;
  /** OIDC subject; `login_hint` on `/api/v1/auth/login` skips the picker. */
  sub: string;
  roles: string;
  does: string;
}

export const TEST_USERS: DemoUser[] = [
  { name: 'Dana Drafter', sub: 'dev-drafter', roles: 'drafter', does: 'Writes the notes on HB 1004, HB 2081, ESSB 5814 and SHB 2402' },
  { name: 'Rae Reviewer', sub: 'dev-reviewer', roles: 'reviewer', does: 'Creates notes, reviews, requests changes, approves, publishes' },
  { name: 'Cam Committee', sub: 'dev-committee', roles: 'viewer', does: 'Reads published notes and their exports' },
  { name: 'Jordan Both', sub: 'dev-both', roles: 'drafter, reviewer', does: 'Drafts the HB 1019 note; reviews as Rae does' },
];

/** The five notes `wa-leg demo seed` creates, one per status in path order. */
export interface DemoNote {
  /** Display label of the bill version, e.g. `ESSB 5814`. */
  bill: string;
  biennium: string;
  billId: string;
  versionCode: string;
  title: string;
  drafter: string;
  state: WorkflowState;
  shows: string;
}

export const DEMO_NOTES: DemoNote[] = [
  {
    bill: 'HB 1004',
    biennium: '2025-26',
    billId: 'HB1004',
    versionCode: 'I',
    title: 'Personal property tax exemption',
    drafter: 'Dana Drafter',
    state: 'draft',
    shows: 'Created by Rae for Dana; Dana has started the narrative',
  },
  {
    bill: 'HB 2081',
    biennium: '2025-26',
    billId: 'HB2081',
    versionCode: 'I',
    title: 'B&O surcharges',
    drafter: 'Dana Drafter',
    state: 'in_review',
    shows: 'Submitted by Dana with a message; no reviewer has acted yet',
  },
  {
    bill: 'ESSB 5814',
    biennium: '2025-26',
    billId: 'SB5814',
    versionCode: 'S.E',
    title: 'Sales tax on services',
    drafter: 'Dana Drafter',
    state: 'changes_requested',
    shows: 'Rae requested changes with a message; two open comment threads for Dana to resolve',
  },
  {
    bill: 'HB 1019',
    biennium: '2025-26',
    billId: 'HB1019',
    versionCode: 'I',
    title: 'Farm equipment tax credit',
    drafter: 'Jordan Both',
    state: 'approved',
    shows: 'Approved by Rae after one round of changes; History holds the request and the reply',
  },
  {
    bill: 'SHB 2402',
    biennium: '2025-26',
    billId: 'HB2402',
    versionCode: 'S',
    title: 'Phthalates in intravenous equipment',
    drafter: 'Dana Drafter',
    state: 'published',
    shows: 'Published by Rae; beside the bill and on the Published page with four export links',
  },
];

export function demoUser(sub: string): DemoUser | undefined {
  return TEST_USERS.find((u) => u.sub === sub);
}
