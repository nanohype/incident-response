import tseslint from 'typescript-eslint';
import base from './eslint.base.mjs';

export default tseslint.config(
  // Vendored byte-identical copies from nanohype (library/runtime) — linted
  // upstream; a local lint fix would be drift by definition.
  { ignores: ['src/vendor/**'] },
  // Org base (vendored from nanohype library/config, drift-gated).
  ...base,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Security-critical: all Promises must be awaited or explicitly handled.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'error',
    },
  },
);
