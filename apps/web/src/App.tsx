import { Route, Routes } from 'react-router';
import { SessionProvider } from './lib/session';
import { Shell } from './components/Shell';
import { Home } from './routes/Home';
import { DrafterDashboard } from './routes/DrafterDashboard';
import { ReviewerDashboard } from './routes/ReviewerDashboard';
import { Inbox } from './routes/Inbox';
import { NotFound } from './routes/NotFound';
import { Placeholder } from './routes/Placeholder';
import { BillPage } from './routes/BillPage';
import { ComparePage } from './routes/ComparePage';

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="dashboard/drafter" element={<DrafterDashboard />} />
          <Route path="dashboard/reviewer" element={<ReviewerDashboard />} />
          <Route path="bills/:biennium/:id" element={<BillPage />} />
          <Route path="bills/:biennium/:id/compare" element={<ComparePage />} />
          <Route path="bills/:biennium/:id/:code" element={<BillPage />} />
          <Route path="notes/:revisionId" element={<Placeholder title="Workspace" />} />
          <Route path="notes/:revisionId/versions" element={<Placeholder title="Document versions" />} />
          <Route path="search" element={<Placeholder title="Search results" />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="admin/templates" element={<Placeholder title="Templates" />} />
          <Route path="admin/ingest" element={<Placeholder title="Ingest" />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
