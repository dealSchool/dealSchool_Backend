import { NextRequest, NextResponse } from "next/server";

function getAllowedOrigins(): string[] {
  const envOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const appBase = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (appBase && !envOrigins.includes(appBase)) envOrigins.push(appBase);

  return envOrigins;
}

export function middleware(request: NextRequest) {
  const origin  = request.headers.get("origin") || "";
  const allowed = getAllowedOrigins();
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin":  corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };

  // Respond to preflight immediately — don't forward to the route handler
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  // Forward to the route handler and attach CORS headers to the response
  const response = NextResponse.next();
  Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
