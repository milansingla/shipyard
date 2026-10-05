import type { NextConfig } from "next";

// Where the dashboard's server reaches the Shipyard API. Browsers never talk
// to it directly: they call /api on the dashboard's own origin, and Next.js
// proxies the request. One origin means the session cookie, the OAuth
// callback and the API's Origin check all just work — no CORS.
const apiUrl = (process.env.SHIPYARD_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The dashboard can trigger deployments: never let another site frame it (clickjacking).
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
