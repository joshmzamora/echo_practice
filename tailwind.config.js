/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Aptos', 'Avenir Next', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
