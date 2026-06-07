/** @type {import('tailwindcss').Config} */
// Tailwind CSS 3.4 is present in the stack per the ERD. The first scaffold
// leans on the prototype's design-token CSS (src/styles/tokens.css) and the
// adapted component CSS (src/styles/console.css, src/styles/auth.css) for the
// console look, while Tailwind utilities are available for new UI. Token values
// are mirrored here so utilities like `bg-brand-600` or `text-ink-2` match the
// design system when later tasks reach for them.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#F7F4EE', deep: '#F1ECE2' },
        surface: { DEFAULT: '#FFFFFF', 2: '#FBF9F4' },
        sunken: '#EFEAE0',
        border: {
          faint: '#ECE6DB',
          DEFAULT: '#E0D9CC',
          strong: '#CFC7B6',
        },
        ink: {
          DEFAULT: '#26241F',
          2: '#5C584F',
          3: '#8A8478',
          4: '#B3AC9E',
        },
        brand: {
          50: '#E9F3F1',
          100: '#D2E8E3',
          200: '#A6D2C8',
          300: '#6FB7A8',
          400: '#3E9787',
          500: '#1A8676',
          600: '#0F766E',
          700: '#0B5F58',
          800: '#094B45',
          900: '#07332F',
        },
        signal: '#7FD1C1',
        ok: { DEFAULT: '#2E9E6B', tint: '#E4F3EC', ink: '#1C6B47' },
        info: { DEFAULT: '#3B82C4', tint: '#E6F0F8', ink: '#285C8C' },
        warn: { DEFAULT: '#C8901F', tint: '#F7EEDA', ink: '#8A6210' },
        crit: { DEFAULT: '#C9534A', tint: '#F7E6E3', ink: '#973B33' },
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SF Mono', 'Cascadia Code', 'monospace'],
      },
      borderRadius: {
        xs: '6px',
        sm: '8px',
        md: '10px',
        lg: '14px',
        xl: '20px',
      },
    },
  },
  plugins: [],
};
