'use strict'

module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  env: {
    node: true,
    browser: true,
    es2022: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  overrides: [
    {
      // Forbid electron, react, and three in core modules (must stay pure TS)
      files: ['src/core/**/*.ts', 'src/core/**/*.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['electron', 'electron/*'],
                message: 'src/core must not import from electron'
              },
              {
                group: ['react', 'react-dom', 'react/*'],
                message: 'src/core must not import from react'
              },
              {
                group: ['three', 'three/*'],
                message: 'src/core must not import from three'
              }
            ]
          }
        ]
      }
    }
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn'
  }
}
