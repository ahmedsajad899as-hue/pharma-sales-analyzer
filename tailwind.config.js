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
        success: {
          DEFAULT: '#0d9f6e',
          bg:      '#e6f7f2',
          border:  '#a7e8d3',
        },
        warning: {
          DEFAULT: '#d97706',
          bg:      '#fef3dc',
          border:  '#fde68a',
        },
        danger: {
          DEFAULT: '#dc2626',
          bg:      '#fef2f2',
          border:  '#fecaca',
        },
        purple: {
          DEFAULT: '#6d28d9',
          hover:   '#5b21b6',
          bg:      '#ede9fe',
          border:  '#c4b5fd',
        },
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
