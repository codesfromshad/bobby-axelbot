/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  verbose: false,
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
