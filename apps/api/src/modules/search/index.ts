import type { FastifyInstance } from 'fastify';
import { OpenSearchBackend } from './opensearch.js';
import { PostgresBackend } from './postgres.js';
import { SearchPipeline } from './pipeline.js';
import { SearchIndexer } from './indexer.js';
import { searchRoutes } from './routes.js';
import type { SearchBackend } from './backend.js';

export * from './backend.js';
export { OpenSearchBackend } from './opensearch.js';
export { PostgresBackend } from './postgres.js';
export { SearchPipeline } from './pipeline.js';
export { SearchIndexer, plainTextOfProseMirror } from './indexer.js';
export * from './docs.js';

declare module 'fastify' {
  interface FastifyInstance {
    searchSvc: { backend: SearchBackend; pipeline: SearchPipeline; indexer: SearchIndexer };
  }
}

export function createBackend(app: FastifyInstance): SearchBackend {
  if (app.config.SEARCH_BACKEND === 'opensearch') return new OpenSearchBackend(app.config.OPENSEARCH_URL, app.config.OPENSEARCH_INDEX_PREFIX);
  return new PostgresBackend(app.db);
}

/** Creates the search services on the root instance (decoration must happen outside the /api/v1 scope). */
export function createSearch(app: FastifyInstance): { backend: SearchBackend; pipeline: SearchPipeline; indexer: SearchIndexer } {
  const backend = createBackend(app);
  const pipeline = new SearchPipeline(app, backend);
  const indexer = new SearchIndexer(app, backend);
  app.decorate('searchSvc', { backend, pipeline, indexer });
  app.healthChecks.search = async () => {
    const h = await backend.health();
    return { ok: h.ok, detail: `${backend.name}${h.detail ? ': ' + h.detail : ''}` };
  };
  indexer.subscribe();
  return { backend, pipeline, indexer };
}

export { searchRoutes };
