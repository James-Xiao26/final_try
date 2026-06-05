/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pre-launch the site is waitlist-only: send the bare domain to the early-access landing so the
  // root never renders the Supabase-backed Activity page (which 500s without DB env vars). Remove
  // this redirect when the full app goes live. 307 (permanent: false) so browsers don't hard-cache
  // it past launch.
  async redirects() {
    return [{ source: "/", destination: "/early-access", permanent: false }];
  }
};

export default nextConfig;
