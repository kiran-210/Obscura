/** @type {import('tailwindcss').Config} */

// "Mist" palette — Dark Obscura theme.
// Warm, desaturated neutrals (the fog) + a single gold accent (the backlit sun
// through fog), pulled from the obscura-in-mist mood image. `mist`/`halo` are the
// canonical names; `ink`/`spectral` alias them so existing classes re-theme with
// no edits, and the default cool `zinc` text ramp is warmed to match.
const mist = {
  50: '#F3F0E7',
  100: '#E9E4D5',
  200: '#D6D0BC',
  300: '#BBB49E',
  400: '#9A9583',
  500: '#78735F',
  600: '#565243',
  700: '#3B382D',
  750: '#302E24',
  800: '#24221B',
  850: '#1C1A14',
  900: '#16150F',
  950: '#0F0E09',
}

const halo = {
  DEFAULT: '#EDEBE6',
  soft: '#F7F6F2',
  dim: '#B6B3AC',
  glow: '#F2F0EB',
  deep: '#6E6B64',
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
const warmZinc = {
  50: '#F6F3EA',
  100: '#ECE7D9',
  200: '#D8D2BF',
  300: '#BBB49E',
  400: '#948F7D',
  500: '#726E5C',
  600: '#524E41',
  700: '#3B382D',
  800: '#24221B',
  900: '#16150F',
  950: '#0F0E09',
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
