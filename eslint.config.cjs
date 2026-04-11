const nextConfig = require('eslint-config-next')

// eslint-config-next exports a legacy config; include it here for compatibility
const baseConfigs = Array.isArray(nextConfig) ? nextConfig : [nextConfig]

module.exports = [
  ...baseConfigs,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: ["node_modules/**", ".next/**"],
    languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
    },
  },
]
