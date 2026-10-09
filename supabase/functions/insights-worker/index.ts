import { dbRpc } from '../_shared/db.ts';
import { insightsWorkerRoute } from './worker.ts';

// Await the bounded call and transactional result. Acceptance alone is never completion.
Deno.serve(request => insightsWorkerRoute(request, { rpc: dbRpc,
  log: state => console.log(JSON.stringify({ event: 'pdd404.insights_worker', schemaVersion: 1, state })),
}));
