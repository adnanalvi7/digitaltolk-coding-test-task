import type { Config } from 'jest';

/** Performance suite: run explicitly with `npm run test:perf` (needs a build and a seeded DB). */
const config: Config = {
  rootDir: '.',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/perf/**/*.perf-spec.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  testTimeout: 900_000,
};

export default config;
