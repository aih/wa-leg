import { Route, Routes } from 'react-router';
import { NoteWorkspace } from './routes/NoteWorkspace';
import { NoteVersionsPage } from './routes/NoteVersionsPage';
import { AdminAudit } from './routes/AdminAudit';
import { AdminTemplates } from './routes/AdminTemplates';
import { AdminIngest } from './routes/AdminIngest';
import { SessionProvider } from './lib/session';
import { Shell } from './components/Shell';
import { Home } from './routes/Home';
import { Guide } from './routes/Guide';
import { DrafterDashboard } from './routes/DrafterDashboard';
import { ReviewerDashboard } from './routes/ReviewerDashboard';
import { Inbox } from './routes/Inbox';
import { NotFound } from './routes/NotFound';
import { BillPage } from './routes/BillPage';
import { ComparePage } from './routes/ComparePage';
import { SearchResults } from './routes/SearchResults';

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="guide" element={<Guide />} />
          <Route path="dashboard/drafter" element={<DrafterDashboard />} />
          <Route path="dashboard/reviewer" element={<ReviewerDashboard />} />
          <Route path="bills/:biennium/:id" element={<BillPage />} />
          <Route path="bills/:biennium/:id/compare" element={<ComparePage />} />
          <Route path="bills/:biennium/:id/:code" element={<BillPage />} />
          <Route path="notes/:revisionId" element={<NoteWorkspace />} />
          <Route path="notes/:revisionId/versions" element={<NoteVersionsPage />} />
          <Route path="search" element={<SearchResults />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="admin/templates" element={<AdminTemplates />} />
          <Route path="admin/ingest" element={<AdminIngest />} />
          <Route path="admin/audit" element={<AdminAudit />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
