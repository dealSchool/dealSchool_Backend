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
