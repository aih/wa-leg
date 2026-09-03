import { RequireRole } from '../components/RequireRole';

const sections = [
  'My notes needing action',
  'My notes waiting on others',
  'My review assignments',
  'Recently approved',
  'Bill change alerts',
];

export function DrafterDashboard() {
  return (
    <RequireRole roles={['drafter']}>
      <h1>Drafter dashboard</h1>
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
