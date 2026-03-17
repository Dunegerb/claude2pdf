/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/**/*.html", "./views/**/*.ejs"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        serif: ["Playfair Display", "serif"],
      },
      colors: {
        apple: {
          bg: "#fbfbfd",
          surface: "#ffffff",
          text: "#1d1d1f",
          subtext: "#86868b",
          border: "#d2d2d7",
          focus: "#0071e3",
        },
      },
      transitionTimingFunction: {
        apple: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
}
