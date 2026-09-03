import { Route, Routes } from 'react-router';
import { NoteWorkspace } from './routes/NoteWorkspace';
import { SessionProvider } from './lib/session';
import { Shell } from './components/Shell';
import { Home } from './routes/Home';
import { Guide } from './routes/Guide';
import { Notes } from './routes/Notes';
import { Published } from './routes/Published';
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
          <Route path="notes" element={<Notes />} />
          <Route path="published" element={<Published />} />
          <Route path="bills/:biennium/:id" element={<BillPage />} />
          <Route path="bills/:biennium/:id/compare" element={<ComparePage />} />
          <Route path="bills/:biennium/:id/:code" element={<BillPage />} />
          <Route path="notes/:revisionId" element={<NoteWorkspace />} />
          <Route path="search" element={<SearchResults />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
