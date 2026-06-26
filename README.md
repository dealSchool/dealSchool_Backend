# DealSchool Backend

API-only backend for the DealSchool Venture Fellowship platform. Handles applications, contact inquiries, admin management, and Razorpay payment links.

Built with **Next.js 15** (API routes only), **Firebase Admin SDK**, and **Razorpay**.

---

## Tech Stack

- **Runtime** — Node.js via Next.js 15 App Router (API routes)
- **Database** — Firebase Firestore (via Admin SDK)
- **Payments** — Razorpay payment links
- **Email** — Nodemailer with Google Workspace SMTP
- **Auth** — Firebase ID token verification (admin routes)

---

## Prerequisites

- Node.js 18+
- A [Firebase project](https://console.firebase.google.com) with Firestore enabled
- A [Razorpay account](https://razorpay.com) (test mode is fine for development)
- A Google Workspace or Gmail SMTP account for sending emails

---

## Local Setup

### 1. Clone the repo

```bash
git clone https://github.com/dealSchool/dealSchool_Backend.git
cd dealSchool_Backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your environment file

Create a file called `.env.local` in the project root. This file is gitignored and will never be committed.

```bash
cp .env.example .env.local   # if .env.example exists, otherwise create manually
```

Fill in all values — see [Environment Variables](#environment-variables) below.

### 4. Run the dev server

```bash
npm run dev
```

Server starts at `http://localhost:3001`

---

## Environment Variables

Create `.env.local` in the project root with the following:

```env
# ── Razorpay ──────────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Fellowship fee in rupees (e.g. 1000 = ₹1000 payment link)
FELLOWSHIP_FEE=1000

# ── App URL (Razorpay redirects here after payment) ───────────────────────────
APP_BASE_URL=http://localhost:3000

# ── Email (Nodemailer / Google Workspace SMTP) ────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=your_smtp_app_password
ADMIN_EMAIL=admin@yourdomain.com

# ── CORS — comma-separated list of allowed frontend origins ───────────────────
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# ── Firebase Web API Key (for admin login via REST) ───────────────────────────
FIREBASE_WEB_API_KEY=your_firebase_web_api_key

# ── Firebase Admin SDK ────────────────────────────────────────────────────────
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_HERE\n-----END PRIVATE KEY-----\n"
```

### Where to get each value

| Variable | Where to find it |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Settings → Webhooks → your webhook secret |
| `FIREBASE_WEB_API_KEY` | Firebase Console → Project Settings → General → Web API Key |
| `FIREBASE_PROJECT_ID` | Firebase Console → Project Settings → General → Project ID |
| `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Firebase Console → Project Settings → Service Accounts → Generate new private key |
| `SMTP_PASS` | Google Account → Security → App Passwords (requires 2FA enabled) |

> **Note on `FIREBASE_PRIVATE_KEY`:** Copy the entire key from the downloaded JSON file including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Wrap the whole thing in double quotes in your `.env.local`.

---

## Project Structure

```
src/
├── app/
│   └── api/
│       ├── applications/
│       │   ├── route.ts          # GET (admin list) + POST (public submit)
│       │   ├── check/route.ts    # POST (public duplicate check)
│       │   └── [id]/route.ts     # PATCH + DELETE (admin)
│       ├── contacts/
│       │   ├── route.ts          # GET (admin list) + POST (public submit)
│       │   └── [id]/route.ts     # PATCH + DELETE (admin)
│       ├── payment/
│       │   ├── create-link/route.ts   # POST (admin manual link create)
│       │   └── resend/route.ts        # POST (admin resend link)
│       ├── auth/
│       │   ├── login/route.ts
│       │   ├── forgot-password/route.ts
│       │   ├── request-otp/route.ts
│       │   └── change-password/route.ts
│       └── webhooks/
│           └── razorpay/route.ts  # Razorpay payment events
└── lib/
    ├── firebase-admin.ts    # Firestore + Auth init
    ├── razorpay.ts          # Razorpay client init
    ├── payment-service.ts   # Payment link creation + email logic
    ├── mailer.ts            # Nodemailer SMTP setup
    ├── email-templates.ts   # All HTML email templates
    ├── verify-admin.ts      # Firebase ID token verification
    ├── cors.ts              # CORS headers
    ├── rate-limit.ts        # IP-based rate limiting
    └── validate.ts          # Email + header sanitization
```

---

## API Endpoints

### Public (no auth required)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/applications` | Submit fellowship application |
| `POST` | `/api/applications/check` | Check for duplicate email/phone |
| `POST` | `/api/contacts` | Submit contact form inquiry |

### Admin (requires `Authorization: Bearer <firebase-id-token>`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/applications` | Paginated application list + counts |
| `PATCH` | `/api/applications/:id` | Update application status |
| `DELETE` | `/api/applications/:id` | Delete application |
| `GET` | `/api/contacts` | Paginated contact list + counts |
| `PATCH` | `/api/contacts/:id` | Update contact status |
| `DELETE` | `/api/contacts/:id` | Delete contact |
| `POST` | `/api/payment/create-link` | Manually create payment link |
| `POST` | `/api/payment/resend` | Resend payment link |

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/webhooks/razorpay` | Razorpay payment events |

---

## Razorpay Webhook Setup

In your Razorpay Dashboard → Settings → Webhooks:

1. **URL** — `https://yourdomain.com/api/webhooks/razorpay`
2. **Secret** — set any strong string, copy it to `RAZORPAY_WEBHOOK_SECRET` in `.env.local`
3. **Events to enable:**
   - `payment_link.paid`
   - `payment_link.expired`

---

## Changing the Fellowship Fee

Set `FELLOWSHIP_FEE` in `.env.local` to the amount in rupees:

```env
FELLOWSHIP_FEE=5000   # creates ₹5000 payment links
```

Restart the server after changing this value.

---

## Available Scripts

```bash
npm run dev      # Start dev server on port 3001
npm run build    # Production build
npm run start    # Start production server on port 3001
npm run lint     # TypeScript type check
```

---

## Deployment

Set all environment variables from the [Environment Variables](#environment-variables) section in your hosting provider (Vercel, Railway, etc.). Do **not** deploy `.env.local` — configure vars through the platform's dashboard.

For Vercel, the `FIREBASE_PRIVATE_KEY` newlines must be literal `\n` characters (not actual newlines) in the environment variable field.
