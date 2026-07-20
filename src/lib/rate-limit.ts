export function getClientIp(request: Request): string {
  const fwd = (request as any).headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (request as any).headers.get("x-real-ip") || "unknown";
}
