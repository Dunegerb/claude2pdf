/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/index.html",
    "./public/404.html",
    "./views/**/*.ejs"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        serif: ["Playfair Display", "serif"]
      },
      colors: {
        background: 'var(--ic-background)',
        foreground: 'var(--ic-foreground)',
        primary: 'var(--color-primary)',
        border: 'var(--ic-border)',
        card: 'var(--ic-card)',
        muted: 'var(--ic-muted)',
        'muted-foreground': 'var(--color-text-muted)',
        ring: 'var(--ic-ring)',
        apple: {
          bg: "#fbfbfd",
          surface: "#ffffff",
          text: "#1d1d1f",
          subtext: "#86868b",
          border: "#d2d2d7"
        }
      }
    },
  },
  plugins: [],
}
