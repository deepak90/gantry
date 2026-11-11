import { describe, expect, it } from 'vitest';
import { describeConfig, readConfig } from '../src/env';

describe('configuration', () => {
  it('treats empty values from the .env.example template as unset', () => {
    const config = readConfig({ AGENT_MODE: '', AGENT_MODEL_ANALYSIS: '', AGENT_MODEL_CHAT: ' ', AGENT_PROJECT_IDS: '', SUPABASE_SERVICE_ROLE_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ mode: 'mock', projectIds: null, models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' }, openingDelayMs: 2000 });
    expect(readConfig({ AGENT_OPENING_DELAY_MS: '0' } as NodeJS.ProcessEnv).openingDelayMs).toBe(0);
    expect(() => readConfig({ AGENT_OPENING_DELAY_MS: 'soon' } as NodeJS.ProcessEnv)).toThrow(/AGENT_OPENING_DELAY_MS/);
  });

  it('waits to be asked unless AGENT_PROACTIVE=issues', () => {
    expect(readConfig({} as NodeJS.ProcessEnv).proactive).toBe('off');
    expect(readConfig({ AGENT_PROACTIVE: 'issues' } as NodeJS.ProcessEnv).proactive).toBe('issues');
    expect(() => readConfig({ AGENT_PROACTIVE: 'always' } as NodeJS.ProcessEnv)).toThrow(/AGENT_PROACTIVE/);
  });

  it('defaults to live with a key, refuses live without one, and never prints secret values', () => {
    expect(readConfig({ ANTHROPIC_API_KEY: 'sk-secret-value', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' } as NodeJS.ProcessEnv).mode).toBe('live');
    expect(() => readConfig({ AGENT_MODE: 'live' } as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
    const line = describeConfig(readConfig({ SUPABASE_SERVICE_ROLE_KEY: 'service-secret', AGENT_PROJECT_IDS: 'a, b' } as NodeJS.ProcessEnv));
    expect(line).not.toMatch(/service-secret|sk-secret/);
    expect(line).toMatch(/projects=a,b/);
  });
});
