import type { Config } from 'jest';
import base from './jest.config';

/**
 * Coverage gate for the combined unit + e2e run (`npm run test:cov`, CI).
 * Kept out of the base config so `npm test -- --coverage` (unit only) reports
 * coverage without failing on code that is only meaningfully testable
 * against a real database (repositories, controllers, guards wiring).
 */
const config: Config = {
  ...base,
  coverageThreshold: {
    global: { lines: 95, statements: 95, functions: 95, branches: 90 },
  },
};

export default config;
