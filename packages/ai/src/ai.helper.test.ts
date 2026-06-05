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

  describe('OpenAI opt-in (AI_PROVIDER=openai)', () => {
    it('CHAT routes to OpenAI gpt-5 by default', () => {
      const c = AIHelper.getModelConfig(AITask.CHAT, 'prod', { AI_PROVIDER: 'openai' });
      expect(c.provider).toBe('openai');
      expect(c.model).toBe('gpt-5');
    });
    it('honours an explicit OPENAI_MODEL override', () => {
      const c = AIHelper.getModelConfig(AITask.CHAT, 'dev', {
        AI_PROVIDER: 'openai',
        OPENAI_MODEL: 'gpt-5-mini',
      });
      expect(c.model).toBe('gpt-5-mini');
    });
    it('omits temperature for gpt-5 reasoning models', () => {
      expect(AIHelper.getTemperature(AITask.CHAT, 'prod', { AI_PROVIDER: 'openai' })).toBeUndefined();
    });
    it('does not affect vision routing (CHAT-only override)', () => {
      const c = AIHelper.getModelConfig(AITask.PARSE_VISION, 'prod', { AI_PROVIDER: 'openai' });
      expect(c.provider).toBe('groq');
    });
    it('falls back to the dev/prod map when AI_PROVIDER is not openai', () => {
      expect(AIHelper.getModelConfig(AITask.CHAT, 'dev', { AI_PROVIDER: 'groq' }).provider).toBe('local');
    });
  });
});
