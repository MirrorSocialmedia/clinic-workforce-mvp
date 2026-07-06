/** @type {import('next').NextConfig} */

// Validate environment variables at startup
const validateEnv = () => {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter(key => {
    const val = process.env[key];
    return !val || val.includes('CHANGE-ME') || val.includes('change-me');
  });
  if (missing.length > 0 && process.env.NODE_ENV === 'production') {
    console.error('Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
};
validateEnv();

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    DB_HOST: process.env.DB_HOST || 'localhost',
  },
}

module.exports = nextConfig
