import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain static files, so the site can be served by GitHub Pages.
  output: "export",
  // Pages serves project sites under /<repo>; the deploy workflow passes it in.
  basePath: process.env.PAGES_BASE_PATH || undefined,
};

export default nextConfig;
