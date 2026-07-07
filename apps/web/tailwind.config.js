/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#0d7377',
          dark: '#0a5a5d',
          light: '#14a8ad',
        },
        ink: '#0f2830',
      },
    },
  },
  plugins: [],
}
