import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const useExplicitCreds =
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_CLIENT_EMAIL !== "PASTE_SERVICE_ACCOUNT_EMAIL_HERE";

const app =
  getApps().length === 0
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
export const adminAuth = getAuth(app);
