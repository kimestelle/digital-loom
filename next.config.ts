import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Verify a production build without replacing the running dev server's cache.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async redirects() {
    // Keep existing room links, without redirecting the component workbench.
    return [{ source: "/room", destination: "/", permanent: false }];
  },
};

export default nextConfig;
