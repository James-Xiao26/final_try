/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
  // Pre-launch access gating now lives in middleware.ts (waitlist-only for the public, full app for
  // holders of the SITE_ACCESS_KEY cookie), replacing the old `/` → `/early-access` redirect.
};

export default nextConfig;
