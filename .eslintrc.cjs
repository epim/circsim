'use strict'

module.exports = {
  root: true,
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
      // Test doubles legitimately cast through any
      files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off'
      }
    },
    {
      // CLAUDE.md: wall-clock assertions in tests must use ratios or operation
      // counts, never an absolute millisecond bound. CI runners (macos-15-intel
      // in particular) are 2x to 5x slower than a dev machine, so an absolute
      // bound turns into a flake. Time a small and a large input and assert the
      // growth ratio (see src/core/critic/__tests__/sparse.test.ts), or assert
      // an operation count. ESLint reports the file and line of each offender. Covers
      // src/**/__tests__ and the top-level test/ tree (npm run lint lints both).
      files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            // expect(ms).toBeLessThan(400), expect(elapsed).toBeLessThanOrEqual(25), ...
            selector:
              "CallExpression[callee.property.name=/^toBeLessThan(OrEqual)?$/][callee.object.callee.name='expect'][callee.object.arguments.0.name=/^(ms|elapsed|took|duration|perMove)|(Ms|Elapsed|Took|Duration)$/]",
            message:
              'No absolute millisecond bound in tests: compare a small and a large input as a growth ratio (see src/core/critic/__tests__/sparse.test.ts) or assert an operation count. CI runners are up to 5x slower than a dev machine.'
          },
          {
            // expect(performance.now() - t0).toBeLessThan(16), expect(Date.now() - t0).toBeLessThan(5000)
            selector:
              "CallExpression[callee.property.name=/^toBeLessThan(OrEqual)?$/][callee.object.callee.name='expect'][callee.object.arguments.0] :matches(CallExpression[callee.object.name='performance'][callee.property.name='now'], CallExpression[callee.object.name='Date'][callee.property.name='now'])",
            message:
              'No absolute millisecond bound in tests: compare a small and a large input as a growth ratio (see src/core/critic/__tests__/sparse.test.ts) or assert an operation count. CI runners are up to 5x slower than a dev machine.'
          }
        ]
      }
    },
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
