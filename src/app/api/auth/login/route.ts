import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handlePreflight } from "@/lib/cors";

export const runtime = "nodejs";

const FIREBASE_SIGN_IN_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

// POST /api/auth/login — exchange email+password for a Firebase ID token
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  let email: string, password: string;
  try {
    const body = await request.json();
    email = body.email?.trim();
    password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers });
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: "email and password are required" },
      { status: 400, headers }
    );
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing FIREBASE_WEB_API_KEY" },
      { status: 500, headers }
    );
  }

  const res = await fetch(`${FIREBASE_SIGN_IN_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = await res.json();

  if (!res.ok) {
    const code: string = data?.error?.message ?? "UNKNOWN";
    const message =
      code === "INVALID_EMAIL" || code === "INVALID_PASSWORD" || code === "EMAIL_NOT_FOUND"
        ? "Invalid email or password"
        : "Authentication failed";
    return NextResponse.json({ error: message }, { status: 401, headers });
  }

  return NextResponse.json(
    {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn,
      email: data.email,
    },
    { headers }
  );
}

export async function OPTIONS(request: NextRequest) {
  return handlePreflight(request) ?? new Response(null, { status: 204 });
}
