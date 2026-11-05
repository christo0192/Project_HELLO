/*
 * Stock scales that legacy markup still names, re-pointed at the Logsheet tokens
 * so every remaining `text-gray-600` or `bg-accent-600` re-skins without a
 * per-page edit. Greys step through the inks and rules; a warm or cool tint
 * resolves to the shaded field, because status colour is the word, not the hue.
 * Only red keeps a hue: it is a fault, and the fault token is `--danger`.
 */
const neutralScale = {
  50: 'var(--field)',
  100: 'var(--field)',
  200: 'var(--rule)',
  300: 'var(--rule-2)',
  400: 'var(--ink-3)',
  500: 'var(--ink-3)',
  600: 'var(--ink-2)',
  700: 'var(--ink-2)',
  800: 'var(--ink-2)',
  900: 'var(--ink)',
  950: 'var(--ink)',
};

const accentScale = {
  50: 'var(--field)',
  100: 'var(--field)',
  200: 'var(--rule-2)',
  300: 'var(--control)',
  400: 'var(--ink-3)',
  500: 'var(--ink)',
  600: 'var(--ink)',
  700: 'var(--ink-2)',
  800: 'var(--ink-2)',
  900: 'var(--ink)',
  950: 'var(--ink)',
};

const dangerScale = {
  50: 'var(--paper)',
  100: 'var(--paper)',
  200: 'var(--rule-2)',
  300: 'var(--danger)',
  400: 'var(--danger)',
  500: 'var(--danger)',
  600: 'var(--danger)',
  700: 'var(--danger)',
  800: 'var(--danger)',
  900: 'var(--danger)',
  950: 'var(--danger)',
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: accentScale,
        accent: accentScale,
        gray: neutralScale,
        emerald: accentScale,
        amber: accentScale,
        red: dangerScale,
        // The Logsheet palette (index.css).
        desk: 'var(--desk)',
        paper: 'var(--paper)',
        field: 'var(--field)',
        rule: 'var(--rule)',
        'rule-2': 'var(--rule-2)',
        control: 'var(--control)',
        voice: 'var(--voice)',
        'voice-mark': 'var(--voice-mark)',
        wash: 'var(--wash)',
        ai: 'var(--ai)',
        plate: 'var(--plate)',
        // Semantic tokens, mapped onto the palette in index.css.
        surface: 'var(--surface)',
        'surface-secondary': 'var(--surface-secondary)',
        'surface-tertiary': 'var(--surface-tertiary)',
        // Alpha-capable: `bg-ink/[0.05]` needs an rgb triple.
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
        // Alpha-capable so a filled danger button can lighten on hover.
        error: 'rgb(var(--danger-rgb) / <alpha-value>)',
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
      // The type scale (docs/design/hello-glass-design-system.md §3): 12, 13,
      // 14, 16, 20, 24 and 30, and nothing between them. Weight and ink do the
      // rest of the work.
      //   text-stat     30/36 600  the one answer figure on a screen
      //   text-title    24/32 600  page title (h1)
      //   text-2xl      24/32      a large figure
      //   text-xl       20/28      a figure in a strip
      //   text-section  16/24 600  section / panel title (h2, h3)
      //   text-base     16/24
      //   text-sm       14/20      body
      //   text-label    13/20      labels (+ font-medium), descriptions
      //   text-meta     12/16      table headers, badges, captions
      // Sentence case at every step. No tracking below 24px.
      fontSize: {
        title: ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        stat: ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        section: ['1rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        label: ['0.8125rem', { lineHeight: '1.25rem' }],
        meta: ['0.75rem', { lineHeight: '1rem' }],
        // A stock step off the scale, folded onto it.
        lg: ['1rem', { lineHeight: '1.5rem' }],
      },
      // One tight family, like a printed form (index.css). The stock names fold
      // onto it so a page written against the old pill-and-card radii re-skins.
      borderRadius: {
        sheet: 'var(--radius-sheet)',
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
        chip: 'var(--radius-chip)',
        evidence: 'var(--radius-evidence)',
        sm: 'var(--radius-evidence)',
        DEFAULT: 'var(--radius-control)',
        md: 'var(--radius-control)',
        lg: 'var(--radius-control)',
        xl: 'var(--radius-control)',
        '2xl': 'var(--radius-control)',
        '3xl': 'var(--radius-control)',
      },
      // Shadows exist on floating layers only.
      boxShadow: {
        pop: 'var(--shadow-pop)',
      },
      // Hover changes colour in 120ms; nothing else on a frequent surface moves.
      transitionDuration: {
        hover: '120ms',
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
