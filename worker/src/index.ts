import { handleApi } from "./gp/api.ts";
import { refreshAll } from "./gp/refresh.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiResponse = await handleApi(request, env, ctx);
    if (apiResponse !== null) {
      return apiResponse;
    }
    // Non-api requests are served by the static assets binding
    // (run_worker_first is limited to /api/*), so reaching here means the
    // asset router did not handle the path.
    return new Response("Not Found", { status: 404 });
  },

  // Await the refresh directly rather than ctx.waitUntil(): the runtime keeps a
  // scheduled invocation alive until its returned promise settles (up to the
  // 15-minute cron limit), whereas waitUntil() only buys ~30s *after* the
  // handler returns. refreshAll fetches 15 sources sequentially and overruns
  // that window, so a waitUntil()'d refresh is cancelled before it writes KV —
  // leaving every /api/gp/<group>.json a 404.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await refreshAll(env);
  },
} satisfies ExportedHandler<Env>;
