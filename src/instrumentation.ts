// Next.js calls register() once when the server process starts (both `next
// dev` and `next start`/pm2). This is where the in-process cron scheduler
// boots — see cron-scheduler.ts for why this replaces an external VPS
// crontab hitting /cron/* over HTTP.
export async function register() {
  // instrumentation.ts runs in both the nodejs and edge runtimes; the
  // scheduler uses node-cron and Firebase Admin, both Node-only, so it must
  // not attempt to load under edge.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCronScheduler } = await import("@/lib/cron-scheduler");
    startCronScheduler();
  }
}
