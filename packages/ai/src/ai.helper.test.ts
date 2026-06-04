import { AIHelper, AITask } from './ai.helper';

describe('AIHelper model selection', () => {
  it('CHAT dev uses local provider', () => {
    expect(AIHelper.getModelConfig(AITask.CHAT, 'dev').provider).toBe('local');
  });
  it('CHAT prod uses groq gpt-oss-120b', () => {
    const c = AIHelper.getModelConfig(AITask.CHAT, 'prod');
    expect(c.provider).toBe('groq');
    expect(c.model).toContain('gpt-oss-120b');
  });
  it('PARSE_VISION routes to a multimodal groq model', () => {
    expect(AIHelper.getModelConfig(AITask.PARSE_VISION, 'prod').model).toContain('scout');
  });
});
