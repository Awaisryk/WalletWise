/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { decoratorMetadata: true, legacyDecorator: true },
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  clearMocks: true,
  restoreMocks: true,
};
