import type { NextConfig } from "next";

// NEXT_PUBLIC_BACKEND_URL is inlined at build time. A hosted build without it would point every visitor at their own
// localhost:8000, so a Vercel build fails loudly instead of deploying a frontend that can never reach its backend.
if (process.env.VERCEL && !process.env.NEXT_PUBLIC_BACKEND_URL) {
  throw new Error("Set NEXT_PUBLIC_BACKEND_URL (the backend's https URL, e.g. https://aquasentinal-backend.onrender.com) in the Vercel project environment.");
}

const nextConfig: NextConfig = {
  // the dev badge sits over the scene rail and the mobile card; the demo runs on `next dev`
  devIndicators: false,
};

export default nextConfig;
