import { loadApiEnv } from './env';

describe('loadApiEnv', () => {
  const base = {
    NODE_ENV: 'test', PORT: '4000', CLIENT_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/w',
    REDIS_URL: 'redis://localhost:6379',
    SUPERTOKENS_CORE_URL: 'http://localhost:3567',
    AI_ENV: 'dev', LOCAL_AI_BASE_URL: 'http://localhost:1234/v1',
  };
  it('parses a valid env', () => {
    const env = loadApiEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.AI_ENV).toBe('dev');
  });
  it('throws on missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => loadApiEnv(rest)).toThrow();
  });
  it('coerces PORT to number', () => {
    expect(typeof loadApiEnv(base).PORT).toBe('number');
  });

  it('treats an empty LOCAL_AI_BASE_URL as unset (env-file placeholder)', () => {
    const env = loadApiEnv({ ...base, LOCAL_AI_BASE_URL: '' });
    expect(env.LOCAL_AI_BASE_URL).toBeUndefined();
  });

  it('still rejects a non-empty invalid LOCAL_AI_BASE_URL', () => {
    expect(() => loadApiEnv({ ...base, LOCAL_AI_BASE_URL: 'not-a-url' })).toThrow();
  });
});
