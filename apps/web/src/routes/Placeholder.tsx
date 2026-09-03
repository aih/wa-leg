import { useParams } from 'react-router';

export function Placeholder({ title }: { title: string }) {
  const params = useParams();
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">This screen is built in a later milestone.</p>
      <pre>{JSON.stringify(params, null, 2)}</pre>
    </section>
  );
}
