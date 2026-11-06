import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Lets a test build live beside the dev server without sharing (and corrupting) its cache.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      // Everything except the widget frame may only be framed by ourselves (clickjacking protection).
      { source: "/((?!embed/).*)", headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] },
      { source: "/embed/:path*", headers: common },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
