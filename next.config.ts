import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Lets a test build live beside the dev server without sharing (and corrupting) its cache.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    // Voice notes need the microphone, but only on the public chat page, the widget frame and the demo page that embeds it.
    const noDevices = { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" };
    const micSelf = { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" };
    const selfFrameOnly = { key: "Content-Security-Policy", value: "frame-ancestors 'self'" };
    return [
      // Everything except the widget frame may only be framed by ourselves (clickjacking protection).
      { source: "/((?!embed/|a/|demo/).*)", headers: [...base, noDevices, selfFrameOnly] },
      { source: "/a/:path*", headers: [...base, micSelf, selfFrameOnly] },
      // The demo store page embeds the widget frame (same origin), which needs to be able to ask for the microphone.
      { source: "/demo/:path*", headers: [...base, micSelf, selfFrameOnly] },
      // /embed gets its frame-ancestors CSP from the agent's allowed sites in proxy.ts.
      { source: "/embed/:path*", headers: [...base, micSelf] },
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
