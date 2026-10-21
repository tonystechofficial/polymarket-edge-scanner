import { app } from './api/app.ts';
import { parseConfig } from './env.ts';
import { aiBindingFrom, runScan } from './scan/run.ts';

export { app, runScan };

export default {
  fetch: app.fetch,

  /** Cron entry point: one bounded run per trigger, nothing kept alive in between. */
  async scheduled(controller, env, _ctx) {
    const cfg = parseConfig(env);
    const summary = await runScan(env, 'cron', { ai: cfg.aiEnabled ? aiBindingFrom(env) : null });
    console.log(JSON.stringify({ event: 'scheduled_run', cron: controller.cron, scheduledTime: new Date(controller.scheduledTime).toISOString(), ...summary }));
  },
} satisfies ExportedHandler<Env>;
