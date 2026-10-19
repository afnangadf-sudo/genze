/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@genze/shared"],
  // Standalone server for Docker hosting (Hugging Face Spaces).
  output: "standalone",
};

export default nextConfig;
