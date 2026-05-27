/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Docker deploy in Phase E — emits a self-contained bundle in .next/standalone/
  output: "standalone",
  // Enables src/instrumentation.ts (prom-client server-startup init);
  // stable in Next 15, safe to drop on upgrade.
  experimental: {
    instrumentationHook: true,
    // Allow Next.js SWC loader to transpile .ts files that live outside the
    // faucet/ project root (e.g. tests/integration/generated/Token.ts imported
    // by src/lib/l2-mint.ts). Without this flag, webpack's codeCondition has
    // `include: [dir]` which rejects any file above the project root.
    externalDir: true,
  },
  // API-only service — no React components, no double-render concern.
  reactStrictMode: false,
  // ESM convention: .ts files import siblings as ".js" (paired with type:module
  // in package.json). Vitest + tsc resolve this natively; Next 14's webpack needs
  // an explicit extensionAlias to map .js requests to .ts/.tsx files.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
