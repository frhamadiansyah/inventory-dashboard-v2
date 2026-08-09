import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the phone (same WiFi/hotspot) to hit the dev server for mobile testing.
  allowedDevOrigins: ["172.20.10.12"],
};

export default nextConfig;
