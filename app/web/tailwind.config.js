/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // HR-approved screenshot palette. Semantic application colors are
        // CSS variables below; these scales keep legacy utilities on the same
        // visual system while page migrations are completed.
        brand: {
          50: '#f4f6fb',
          100: '#eaeef6',
          200: '#dbe1ec',
          300: '#b5c8d8',
          400: '#7ba7c7',
          500: '#4E6BA6',
          600: '#4E6BA6',
          700: '#1E7590',
          800: '#334155',
          900: '#0f172a',
          950: '#0f172a',
        },
        // Compatibility alias for existing accent utilities.
        accent: {
          50: '#f4f6fb',
          100: '#eaeef6',
          200: '#dbe1ec',
          300: '#b5c8d8',
          400: '#7BA7C7',
          500: '#4E6BA6',
          600: '#4E6BA6',
          700: '#1E7590',
          800: '#334155',
          900: '#0f172a',
          950: '#0f172a',
        },
        // Semantic tokens — light-first values from index.css.
        surface: 'var(--surface)',
        'surface-secondary': 'var(--surface-secondary)',
        'surface-tertiary': 'var(--surface-tertiary)',
        ink: 'var(--ink)',
        'ink-secondary': 'var(--ink-secondary)',
        'ink-tertiary': 'var(--ink-tertiary)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        error: 'var(--error)',
        'error-soft': 'var(--error-soft)',
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 31 49 / 0.04), 0 1px 3px 0 rgb(16 31 49 / 0.06)',
        'card-hover':
          '0 4px 14px -2px rgb(16 31 49 / 0.12), 0 2px 4px -2px rgb(16 31 49 / 0.06)',
      },
      maxWidth: {
        page: '80rem',
      },
    },
  },
  plugins: [],
};
