/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    DB_HOST: process.env.DB_HOST || 'localhost',
  },
}

module.exports = nextConfig
