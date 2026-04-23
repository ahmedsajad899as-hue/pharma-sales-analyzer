/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Tajawal', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      colors: {
        primary: {
          DEFAULT: '#0f1e35',
          mid:     '#162844',
          light:   '#1a3a6b',
        },
        accent: {
          DEFAULT: '#1a56db',
          hover:   '#1648c0',
          light:   '#ebf0fc',
        },
        surface: '#ffffff',
        'app-bg': '#f0f2f7',
        border: {
          DEFAULT: '#dde3ef',
          light:   '#edf0f7',
        },
        text: {
          primary:   '#1a2332',
          secondary: '#5a6a8a',
          muted:     '#8fa0be',
        },
      },
    },
  },
  plugins: [],
}
