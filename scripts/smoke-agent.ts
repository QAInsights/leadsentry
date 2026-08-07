// Smoke test for the agent loop: drives runAgent with a scripted mock model
// (no API keys needed). Run: npx tsx scripts/smoke-agent.ts
import { MockLanguageModelV3 } from 'ai/test';
import { runAgent } from '../src/agent.js';
import { DemoMireyeClient, DemoCensusClient } from '../src/demo/fixtures.js';
import { AssessmentStore } from '../src/store.js';

const ADDRESSES = [
  '436 Massachusetts Ave, Buffalo, NY 14213',
  '35 Maple View Ln, Amherst, NY 14221',
];

// Script: for each address -> mireye_fetch, census_pre1980_share,
// score_address, record_assessment; then a final text reply.
const script: object[] = [];
for (const address of ADDRESSES) {
  const call = (toolName: string, input: object, id: string) => ({
    content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const },
    usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5 } },
    warnings: [],
  });
  script.push(call('mireye_fetch', { address }, `${address}-1`));
  script.push(
    call(
      'census_pre1980_share',
      {
        tract_geoid: address.includes('Massachusetts') ? '36029006500' : '36029009411',
        address,
      },
      `${address}-2`,
    ),
  );
  script.push(call('score_address', { address }, `${address}-3`));
  script.push(
    call(
      'record_assessment',
      {
        address,
        reasoning: 'Mock reasoning: data complete, action follows band policy.',
        confidence: 'high',
        action: address.includes('Massachusetts') ? 'testkit_dispatch' : 'none',
      },
      `${address}-4`,
    ),
  );
}
script.push({
  content: [{ type: 'text', text: 'Triage complete for 2 addresses.' }],
  finishReason: { unified: 'stop' as const },
  usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5 } },
  warnings: [],
});

const model = new MockLanguageModelV3({ doGenerate: script as never[] });
const store = new AssessmentStore();
const summary = await runAgent(ADDRESSES, {
  model: model as never,
  mireye: new DemoMireyeClient(),
  census: new DemoCensusClient(),
  store,
});

console.log('SUMMARY:', summary);
console.log('STORE SIZE:', store.all().length);
for (const a of store.ranked()) {
  console.log(
    `${a.address} | score=${a.score?.score} band=${a.score?.band} action=${a.action} file=${a.actionFile} confidence=${a.confidence}`,
  );
  if (!a.score || !a.agentReasoning) throw new Error(`incomplete assessment for ${a.address}`);
}
console.log('SMOKE OK');
