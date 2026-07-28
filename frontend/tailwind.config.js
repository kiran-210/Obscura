/** @type {import('tailwindcss').Config} */

// "Mist" palette — Dark Obscura theme.
// Warm, desaturated neutrals (the fog) + a single gold accent (the backlit sun
// through fog), pulled from the obscura-in-mist mood image. `mist`/`halo` are the
// canonical names; `ink`/`spectral` alias them so existing classes re-theme with
// no edits, and the default cool `zinc` text ramp is warmed to match.
// ShieldBid palette — cyan on white.
//
// The ramp is INVERTED relative to the old dark theme: `950` (which the body and
// panels use) is now white and `50` is the deepest cyan. Every existing
// `bg-ink-*` / `border-ink-*` class re-themes with no component edits, which is
// why the surface names were kept.
const mist = {
  50: '#007A7A',
  100: '#009B9B',
  200: '#00B8B8',
  300: '#00CDCD',
  400: '#33D6D6',
  500: '#5CDEDE',
  600: '#8AE8E8',
  700: '#B3F0F0',
  750: '#CCF7F7',
  800: '#DFFAFA',
  850: '#ECFDFD',
  900: '#F5FEFE',
  950: '#FFFFFF',
}

// Accent — the two brand cyans.
const halo = {
  DEFAULT: '#00CDCD',
  soft: '#00FFFF',
  dim: '#4DD9D9',
  glow: '#00FFFF',
  deep: '#009B9B',
}

// Warm antique-gold accent for positive/confirmed states — the sepia-world
// stand-in for the old emerald "success" green. Olive-brass so it reads warm
// and stays clearly apart from the brighter `amber` used for warnings.
const patina = {
  300: '#D6C57C',
  400: '#BFA24C',
  500: '#9C7F30',
}

// Warm the default grey text scale so existing `text-zinc-*` reads warm (fog),
// not cool. Deep-merges with Tailwind's zinc, overriding the shades in use.
// Text ramp, also INVERTED: `text-zinc-100/200` (headings) are now near-black
// teal and `text-zinc-500/600` (muted) are mid-teal, so existing classes stay
// legible on the white surfaces above instead of turning invisible.
const warmZinc = {
  50: '#000000',
  100: '#000000',
  200: '#0A0A0A',
  300: '#141414',
  400: '#262626',
  500: '#3D3D3D',
  600: '#545454',
  700: '#8A8A8A',
  800: '#C2C2C2',
  900: '#E8E8E8',
  950: '#FFFFFF',
}

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        mist,
        halo,
        ink: mist, // alias — existing bg-ink-*/border-ink-* now read warm.
        spectral: halo, // alias — existing text-spectral/bg-spectral now read gold.
        patina,
        zinc: warmZinc,
      },
      fontFamily: {
        display: ['Space Grotesk', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        // Tight and quiet — no colored glow, no wide diffuse "ghost card" shadow.
        glow: '0 1px 2px 0 rgba(0,0,0,0.35)',
        panel: '0 1px 2px 0 rgba(0,0,0,0.35)',
        hair: '0 0 0 1px rgba(59,56,45,0.9)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { opacity: '0' },
        },
        // Slow drift for the fog haze.
        drift: {
          '0%, 100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(-1.5%, -2%, 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
        'pulse-ring': 'pulse-ring 1.6s cubic-bezier(0.4,0,0.6,1) infinite',
        drift: 'drift 22s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
