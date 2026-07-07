import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { logInfo, logWarn, logError } from "@/lib/logger";

export const runtime = "nodejs";

const FIREBASE_SIGN_IN_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

// POST /auth/login — exchange email+password for a Firebase ID token
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  logInfo("api/auth/login", "POST received", { origin: origin ?? "none" });

  let email: string, password: string;
  try {
    const body = await request.json();
    email = body.email?.trim();
    password = body.password;
  } catch {
    logWarn("api/auth/login", "Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers });
  }

  if (!email || !password) {
    logWarn("api/auth/login", "Missing email or password in body");
    return NextResponse.json(
      { error: "email and password are required" },
      { status: 400, headers }
    );
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) {
    logError("api/auth/login", "FIREBASE_WEB_API_KEY not set — login cannot proceed");
    return NextResponse.json(
      { error: "Server misconfiguration: missing FIREBASE_WEB_API_KEY" },
      { status: 500, headers }
    );
  }

  let res: Response, data: any;
  try {
    res = await fetch(`${FIREBASE_SIGN_IN_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    data = await res.json();
  } catch (err: unknown) {
    logError("api/auth/login", `Firebase sign-in fetch FAILED email=${email}`, err);
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503, headers });
  }

  if (!res.ok) {
    const code: string = data?.error?.message ?? "UNKNOWN";
    logWarn("api/auth/login", "Login failed", { email, firebaseCode: code });
    const message =
      code === "INVALID_EMAIL" || code === "INVALID_PASSWORD" || code === "EMAIL_NOT_FOUND"
        ? "Invalid email or password"
        : "Authentication failed";
    return NextResponse.json({ error: message }, { status: 401, headers });
  }

  logInfo("api/auth/login", "Login successful", { email });
  return NextResponse.json(
    {
      idToken:      data.idToken,
      refreshToken: data.refreshToken,
      expiresIn:    data.expiresIn,
      email:        data.email,
    },
    { headers }
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}



