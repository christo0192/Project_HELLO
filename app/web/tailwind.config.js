/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // InterviewKickstart brand — derived from the authorized ik-logo.png
        // (dominant logo primaries: cyan #3996d2 primary, navy #344158
        // secondary). See src/index.css for the semantic token system.
        brand: {
          50: '#eef7fc',
          100: '#d9edf8',
          200: '#b2d9ee',
          300: '#86c0e2',
          400: '#55a7d6',
          500: '#3996d2',
          600: '#2a7cb2',
          700: '#256694',
          800: '#20537a',
          900: '#1c4665',
          950: '#122d42',
        },
        // Legacy alias so pre-existing components re-theme to the IK brand
        // without churn. Kept under both names until consumers migrate.
        accent: {
          50: '#eef7fc',
          100: '#d9edf8',
          200: '#b2d9ee',
          300: '#86c0e2',
          400: '#55a7d6',
          500: '#3996d2',
          600: '#2a7cb2',
          700: '#256694',
          800: '#20537a',
          900: '#1c4665',
          950: '#122d42',
        },
        // Semantic tokens — values switch with the `.dark` class (index.css).
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
