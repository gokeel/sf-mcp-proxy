import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../src/chatBackends.ts';

const clean = <T>(fn: () => T): T => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SFCHAT_') || k.endsWith('_API_KEY') || k === 'ANTHROPIC_MODEL') delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

test('deepseek preset resolves base URL, key env, and default model', () => {
  clean(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds';
    const rp = resolveProvider({ provider: 'deepseek' });
    assert.equal(rp.kind, 'openai');
    assert.equal(rp.baseURL, 'https://api.deepseek.com');
    assert.equal(rp.model, 'deepseek-chat');
    assert.equal(rp.apiKey, 'sk-ds');
  });
});

test('SFCHAT_API_KEY and --model override the preset', () => {
  clean(() => {
    process.env.SFCHAT_API_KEY = 'universal';
    const rp = resolveProvider({ provider: 'qwen', model: 'qwen3-max' });
    assert.equal(rp.model, 'qwen3-max');
    assert.equal(rp.apiKey, 'universal');
    assert.match(rp.baseURL ?? '', /dashscope/);
  });
});

test('custom provider requires base URL, key, and model', () => {
  clean(() => {
    assert.throws(() => resolveProvider({ provider: 'custom' }), /base URL/);
    process.env.SFCHAT_BASE_URL = 'https://llm.internal/v1';
    process.env.SFCHAT_API_KEY = 'k';
    assert.throws(() => resolveProvider({ provider: 'custom' }), /model/);
    const rp = resolveProvider({ provider: 'custom', model: 'local-1' });
    assert.equal(rp.baseURL, 'https://llm.internal/v1');
  });
});

test('missing key is a clear error', () => {
  clean(() => {
    assert.throws(() => resolveProvider({ provider: 'kimi' }), /MOONSHOT_API_KEY/);
  });
});

test('unknown provider is rejected', () => {
  clean(() => assert.throws(() => resolveProvider({ provider: 'bard' }), /Unknown provider/));
});
