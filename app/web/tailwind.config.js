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
        // Alpha-capable: `bg-ink/[0.05]` needs an rgb triple. Candidate scope
        // re-points `--ink`/`--info` to identical values, so the triple is safe.
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        'ink-secondary': 'var(--ink-secondary)',
        'ink-tertiary': 'var(--ink-tertiary)',
        'ink-muted': 'rgb(var(--ink-muted-rgb) / <alpha-value>)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        success: 'var(--success)',
        'success-text': 'var(--success-text)',
        'success-soft': 'var(--success-soft)',
        warning: 'var(--warning)',
        'warning-text': 'var(--warning-text)',
        'warning-soft': 'var(--warning-soft)',
        error: 'var(--error)',
        'error-text': 'var(--error-text)',
        'error-soft': 'var(--error-soft)',
        info: 'rgb(var(--info-rgb) / <alpha-value>)',
        'info-soft': 'var(--info-soft)',
        'glass-ring': 'var(--glass-ring)',
        'glass-ring-strong': 'var(--glass-ring-strong)',
      },
      // IBM Plex Sans / Plex Mono, self-hosted and imported in src/main.tsx. The
      // system stack stays behind them only for the moment before the woff2
      // arrives (`font-display: swap`) — never as a design choice.
      fontFamily: {
        sans: [
          '"IBM Plex Sans Variable"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          '"Liberation Mono"',
          'monospace',
        ],
      },
      // The type scale (docs/design/hello-glass-design-system.md §3). Six
      // steps carry the whole UI; weight and ink do the rest of the work.
      //   text-title    28/34 600  page title (h1)
      //   text-stat     30/36 600  hero figure — pair with `tabular-nums`
      //   text-section  15/20 600  section / panel title (h2, h3)
      //   text-sm       14/20      body (Tailwind's own step)
      //   text-label    13/20      labels (+ font-medium), descriptions
      //   text-meta     12/16      table headers, badges, captions
      // Sentence case at every step: nothing here is uppercase or tracked open.
      fontSize: {
        title: ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        stat: ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        section: ['0.9375rem', { lineHeight: '1.25rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        label: ['0.8125rem', { lineHeight: '1.25rem' }],
        meta: ['0.75rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 31 49 / 0.04), 0 1px 3px 0 rgb(16 31 49 / 0.06)',
        'card-hover':
          '0 4px 14px -2px rgb(16 31 49 / 0.12), 0 2px 4px -2px rgb(16 31 49 / 0.06)',
        glass: 'var(--shadow-glass)',
        'glass-hover': 'var(--shadow-glass-hover)',
        pop: 'var(--shadow-pop)',
        pill: '0 1px 2px rgba(15, 23, 42, 0.08), 0 4px 10px -4px rgba(15, 23, 42, 0.16)',
      },
      transitionTimingFunction: {
        soft: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      maxWidth: {
        page: '84rem',
      },
    },
  },
  plugins: [],
};
