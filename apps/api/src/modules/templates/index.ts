export { templatesRoutes } from './routes.js';
import type { TemplatesService } from './service.js';

export { TemplatesService, seedTemplates, type TemplateSummary, type TemplateFull } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    templates: TemplatesService;
  }
}
