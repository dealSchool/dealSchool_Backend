/** Basic email format check — rejects commas, spaces, angle brackets (injection vectors) */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  if (/[\s,;<>]/.test(email)) return false;          // catch multi-address injection
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Strip newlines / CRLFs to prevent SMTP header injection in To/Subject fields */
export function sanitizeHeader(value: string): string {
  return String(value).replace(/[\r\n\t]+/g, " ").trim();
}

/** Mask an email for display without fully revealing it, e.g. "jo***@gmail.com" */
export function maskEmail(email: string): string {
  const [local, domain] = String(email).split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}
