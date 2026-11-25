import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a check build run in its own folder without breaking a running dev server
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The bundled ffmpeg (providers/ffmpeg/local.ts) is a binary: loaded from node_modules at run time, not bundled,
  // and shipped with the functions that watch videos (every agent runs in the Inngest route)
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/inngest": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
  images: {
    remotePatterns: [
      // Cloudflare R2 public address (NEXT_PUBLIC_MEDIA_URL)
      { protocol: "https", hostname: "**.r2.dev" },
    ],
  },
};

export default nextConfig;
