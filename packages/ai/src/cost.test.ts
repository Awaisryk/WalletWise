import { AIHelper, AITask } from './ai.helper';

describe('AIHelper.calculateCost', () => {
  it('prod CHAT (groq gpt-oss-120b) bills $0.15/M input + $0.75/M output', () => {
    // 1000 input + 1000 output tokens, no cache hits.
    //   input:  1000 * 0.15 / 1e6 = 0.00015
    //   output: 1000 * 0.75 / 1e6 = 0.00075
    //   total                     = 0.0009
    const cost = AIHelper.calculateCost(
      { inputTokens: 1000, outputTokens: 1000 },
      AITask.CHAT,
      'prod',
    );
    expect(cost).toBeCloseTo(0.0009, 10);
  });

  it('prod CHAT splits cached vs non-cached input at 50% of the input rate', () => {
    // 1000 input (400 cached), 500 output.
    //   non-cached input: 600 * 0.15  / 1e6 = 0.00009
    //   cached input:     400 * 0.075 / 1e6 = 0.00003
    //   output:           500 * 0.75  / 1e6 = 0.000375
    //   total                                = 0.000495
    const cost = AIHelper.calculateCost(
      { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500 },
      AITask.CHAT,
      'prod',
    );
    expect(cost).toBeCloseTo(0.000495, 10);
  });

  it('local CHAT is free (dev runs against a local server)', () => {
    const cost = AIHelper.calculateCost(
      { inputTokens: 1000, outputTokens: 1000 },
      AITask.CHAT,
      'dev',
    );
    expect(cost).toBe(0);
  });

  it('normalizeUsage coalesces the ai-sdk v6 usage shape', () => {
    const n = AIHelper.normalizeUsage({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 20,
      totalTokens: 150,
    });
    expect(n.inputTokens).toBe(120);
    expect(n.outputTokens).toBe(30);
    expect(n.cachedInputTokens).toBe(20);
    expect(n.totalTokens).toBe(150);
    expect(n.nonCachedInputTokens).toBe(100);
  });
});
