const path = require('node:path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{ts,tsx}'),
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: '#090A0F',
        elevated: '#12151F',
        ink: {
          primary: '#E5E7EB',
          secondary: '#A7B0C0',
        },
        anchor: '#F59E0B',
        accepted: '#10B981',
        pending: '#F59E0B',
        failed: '#EF4444',
        prospect: '#38BDF8',
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Microsoft YaHei',
          'PingFang SC',
          'Noto Sans SC',
          'sans-serif',
        ],
        mono: ['Cascadia Mono', 'Consolas', 'SFMono-Regular', 'monospace'],
      },
      transitionDuration: {
        feedback: '120ms',
        normal: '220ms',
        bridge: '420ms',
      },
    },
  },
  plugins: [],
};
