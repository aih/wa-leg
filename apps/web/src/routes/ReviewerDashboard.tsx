import { RequireRole } from '../components/RequireRole';

const sections = [
  'Pending my review',
  'Changes requested',
  'Team queue',
  'Unassigned bills with hearings within 72 hours',
  'Approved this session',
];

export function ReviewerDashboard() {
  return (
    <RequireRole roles={['reviewer', 'approver', 'manager']}>
      <h1>Reviewer dashboard</h1>
      {sections.map((s) => (
        <section key={s} aria-labelledby={slug(s)}>
          <h2 id={slug(s)}>{s}</h2>
          <p className="muted">No rows yet. Work queues arrive with the workflow milestone.</p>
        </section>
      ))}
    </RequireRole>
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
