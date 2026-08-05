import cron from "node-cron";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { runIncompleteApplicantReminder, type ReminderStage as DraftStage } from "@/lib/incomplete-applicant-reminders";
import { runBrochureReminder, type ReminderStage as BrochureStage } from "@/lib/brochure-reminders";
import { runApplicationFollowupReminder } from "@/lib/application-followup-reminder";
import { runApplicationAuditReminder } from "@/lib/application-audit-reminder";
import { runInterviewShortlistedReminder } from "@/lib/interview-shortlisted-reminder";
import { runPaymentReminder } from "@/lib/payment-reminder";

// Runs every WhatsApp nudge job from inside this process instead of relying on
// an external VPS crontab hitting /cron/* over HTTP. Each underlying run*()
// function already filters by "has this record crossed its own age threshold
// AND not yet been sent this stage" (see incomplete-applicant-reminders.ts
// etc.), so ticking all of them on the same hourly schedule is safe — a tick
// that finds nothing to send for a given job is a cheap no-op, and a missed
// tick (deploy restart, brief downtime) is caught by the next one exactly like
// a missed crontab run would be. Moving the schedule in here means migrating
// to a new VPS is just "deploy and pm2 start" — nothing to remember to
// re-add to a fresh server's crontab.
const HOURLY = "0 * * * *"; // top of every hour

// Guards against double-registration — Next.js can invoke instrumentation's
// register() more than once per process in some dev/hot-reload scenarios, and
// this file's module scope could theoretically be re-evaluated. Stored on
// globalThis (not a plain module-level variable) so it survives that.
//
// __dealschoolCronRunning guards against overlapping ticks — node-cron does
// not wait for a previous callback to finish before firing the next scheduled
// one. If a tick ever ran long (Firestore/Cheerio slowness), a second tick
// starting mid-run would re-query the same not-yet-sent documents before the
// first tick's writes land, sending the same WhatsApp message to the same
// applicant twice. Both jobs in the same run also can't overlap each other
// for the same reason, so this is a single flag, not one per job.
declare global {
  // eslint-disable-next-line no-var
  var __dealschoolCronStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __dealschoolCronRunning: boolean | undefined;
}

async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    logInfo("cron-scheduler", `${name} completed`, result as Record<string, unknown>);
  } catch (err) {
    // One job failing (e.g. Cheerio API hiccup) must never stop the rest of
    // the tick's jobs from running.
    logError("cron-scheduler", `${name} failed`, err);
  }
}

async function runAllJobs(): Promise<void> {
  logInfo("cron-scheduler", "Hourly tick starting");

  const draftStages: DraftStage[] = [1, 2, 3];
  for (const stage of draftStages) {
    await runJob(`incomplete-applicants:${stage}`, () => runIncompleteApplicantReminder(stage));
  }

  const brochureStages: BrochureStage[] = [1, 2, 3];
  for (const stage of brochureStages) {
    await runJob(`brochure-reminders:${stage}`, () => runBrochureReminder(stage));
  }

  await runJob("application-followup", () => runApplicationFollowupReminder());
  await runJob("application-audit-followup", () => runApplicationAuditReminder());
  await runJob("interview-shortlisted-followup", () => runInterviewShortlistedReminder());
  await runJob("payment-reminder", () => runPaymentReminder());

  logInfo("cron-scheduler", "Hourly tick complete");
}

// Only ever runs under `next start` (production). `next dev` always sets
// NODE_ENV to "development" — without this gate, any developer running the
// app locally would, after up to an hour, start firing real Firestore
// queries and real WhatsApp messages to real applicants/leads the moment
// .env.local points at the production Firebase project (the common case,
// since there's normally just one project). DISABLE_CRON_SCHEDULER is an
// extra kill switch so ops can pause sends on the VPS itself (env var +
// restart) without a code change/redeploy.
function isSchedulerEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.DISABLE_CRON_SCHEDULER === "true") return false;
  return true;
}

export function startCronScheduler(): void {
  if (globalThis.__dealschoolCronStarted) {
    return;
  }
  globalThis.__dealschoolCronStarted = true;

  if (!isSchedulerEnabled()) {
    logInfo("cron-scheduler", "Internal cron scheduler NOT started", {
      NODE_ENV: process.env.NODE_ENV ?? "undefined",
      DISABLE_CRON_SCHEDULER: process.env.DISABLE_CRON_SCHEDULER ?? "undefined",
    });
    return;
  }

  cron.schedule(HOURLY, () => {
    if (globalThis.__dealschoolCronRunning) {
      logWarn("cron-scheduler", "Skipping tick — previous run still in progress");
      return;
    }
    globalThis.__dealschoolCronRunning = true;
    runAllJobs().finally(() => {
      globalThis.__dealschoolCronRunning = false;
    });
  });

  logInfo("cron-scheduler", "Internal cron scheduler started", { schedule: HOURLY });
}
