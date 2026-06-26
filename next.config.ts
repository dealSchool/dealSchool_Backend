import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // All routes run in Node.js runtime (required for Firebase Admin SDK + Razorpay)
  experimental: {},
};

export default nextConfig;
