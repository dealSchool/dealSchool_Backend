type Level = "INFO" | "WARN" | "ERROR";

function stamp(level: Level, ctx: string, msg: string, data?: Record<string, unknown>): string {
  const ts  = new Date().toISOString();
  const kvs = data
    ? " | " + Object.entries(data)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";
  return `[${ts}] [${level}] [${ctx}] ${msg}${kvs}`;
}

export function logInfo(ctx: string, msg: string, data?: Record<string, unknown>): void {
  console.log(stamp("INFO", ctx, msg, data));
}

export function logWarn(ctx: string, msg: string, data?: Record<string, unknown>): void {
  console.warn(stamp("WARN", ctx, msg, data));
}

export function logError(ctx: string, msg: string, err?: unknown): void {
  console.error(stamp("ERROR", ctx, msg));
  if (err instanceof Error) {
    console.error(`  message : ${err.message}`);
    if (err.stack) {
      const frames = err.stack.split("\n").slice(1);
      for (const f of frames) console.error(`  ${f.trim()}`);
    }
    const e = err as unknown as Record<string, unknown>;
    if (e["code"])         console.error(`  code         : ${e["code"]}`);
    if (e["command"])      console.error(`  smtp_command : ${e["command"]}`);
    if (e["response"])     console.error(`  smtp_response: ${e["response"]}`);
    if (e["responseCode"]) console.error(`  smtp_code    : ${e["responseCode"]}`);
  } else if (err !== undefined && err !== null) {
    console.error(`  error: ${JSON.stringify(err)}`);
  }
}
