import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const useExplicitCreds =
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_CLIENT_EMAIL !== "PASTE_SERVICE_ACCOUNT_EMAIL_HERE";

// Next.js bundles each API route separately, so this module's top-level code
// re-runs once per route bundle even though firebase-admin's app registry
// (getApps()) is shared across all of them in the same Node process. Only the
// bundle that actually creates the app may call adminDb.settings() — Firestore
// throws if settings() runs twice on the same (process-wide cached) instance.
const isFirstInit = getApps().length === 0;

const app = isFirstInit
  ? initializeApp({
      credential: useExplicitCreds
        ? cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          })
        : applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID,
    })
  : getApps()[0];

export const adminDb = getFirestore(app);
if (isFirstInit) {
  adminDb.settings({ ignoreUndefinedProperties: true });
}

export const adminAuth = getAuth(app);
