import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, resolveServiceTier } from '../src/model-settings.mjs';
import { routeModel, runAzure } from '../src/azure-adapter.mjs';

const sol = routeModel('azure-sol');
const astra = routeModel('azure-astra');

test('fast mode is off by default and only sticks for models Azure supports', () => {
  assert.equal(settings()['azure-sol'].fast, false);
  const s = settings({ 'azure-sol': { fast: true }, 'azure-astra': { fast: true } });
  assert.equal(s['azure-sol'].fast, true);
  assert.equal(s['azure-astra'].fast, false, 'Azure has no priority processing for Astra');
});

test('the app toggle turns on priority for supported models only', () => {
  const prefs = { 'azure-sol': { fast: true }, 'azure-astra': { fast: true } };
  assert.equal(resolveServiceTier({}, sol, prefs), 'priority');
  assert.equal(resolveServiceTier({}, astra, prefs), null);
  assert.equal(resolveServiceTier({}, sol, {}), null);
});

test("a client's own service_tier wins and is translated for Azure", () => {
  const on = { 'azure-sol': { fast: true } };
  assert.equal(resolveServiceTier({ service_tier: 'fast' }, sol, {}), 'priority', "OpenAI's 'fast' becomes Azure's 'priority'");
  assert.equal(resolveServiceTier({ service_tier: 'priority' }, sol, {}), 'priority');
  assert.equal(resolveServiceTier({ service_tier: 'default' }, sol, on), 'default', 'client can opt out');
  assert.equal(resolveServiceTier({ service_tier: 'fast' }, astra, {}), null, 'never ask Azure for an unsupported tier');
  assert.equal(resolveServiceTier({ service_tier: 'flex' }, sol, {}), null, 'flex is dropped: Azure rejects it for these models');
  assert.equal(resolveServiceTier({ service_tier: 'auto' }, sol, on), 'priority', 'auto falls back to the app toggle');
});

test('custom models carry their own fast flag and support', () => {
  const router = { id: 'model-router', protocol: 'chat', fast: true, fastSupported: true };
  assert.equal(resolveServiceTier({}, router, {}), 'priority');
  assert.equal(resolveServiceTier({}, { ...router, fast: false }, {}), null);
});

test('only the resolved tier reaches Azure, and the served tier is captured', async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response('data: {"type":"response.completed","response":{"service_tier":"priority","usage":{"input_tokens":5,"output_tokens":2}}}\n\n', { status: 200 });
  };
  const sink = { open(session) { this.session = session; }, complete() {}, completeForTool() {}, text() {}, tool() {} };
  try {
    await runAzure({ body: { model: 'azure-sol', input: 'hi', service_tier: 'fast' }, protocol: 'responses', route: sol, key: 'k', endpoint: 'https://example.test', sink, serviceTier: 'priority' });
    assert.equal(sent[0].service_tier, 'priority', "client's raw 'fast' replaced by Azure's 'priority'");
    assert.equal(sink.session.serviceTier, 'priority');
    await runAzure({ body: { model: 'azure-astra', input: 'hi', service_tier: 'flex' }, protocol: 'responses', route: astra, key: 'k', endpoint: 'https://example.test', sink, serviceTier: null });
    assert.equal('service_tier' in sent[1], false, 'invalid client tiers are stripped');
  } finally { globalThis.fetch = originalFetch; }
});
