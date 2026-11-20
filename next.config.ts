import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { authInterrupts: true },
};

export default config;
