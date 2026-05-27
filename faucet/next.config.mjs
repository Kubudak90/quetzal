/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: { instrumentationHook: true },
  reactStrictMode: false,
};

export default nextConfig;
