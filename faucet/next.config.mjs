/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Docker deploy in Phase E — emits a self-contained bundle in .next/standalone/
  output: "standalone",
  // Enables src/instrumentation.ts (prom-client server-startup init);
  // stable in Next 15, safe to drop on upgrade.
  experimental: { instrumentationHook: true },
  // API-only service — no React components, no double-render concern.
  reactStrictMode: false,
};

export default nextConfig;
