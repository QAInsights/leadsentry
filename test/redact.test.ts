import { describe, it, expect } from 'vitest';
import { Redactor } from '../src/redact.js';
import { AssessmentStore } from '../src/store.js';
import type { Assessment } from '../src/store.js';

function makeAssessment(address: string): Assessment {
  return {
    address,
    resolvedAddress: `${address} resolved`,
    lat: 42.9,
    lng: -78.9,
    parcelGrade: true,
    tractGeoid: '36029006500',
    mireye: null,
    census: null,
    score: null,
    agentReasoning: `We evaluated ${address} and decided to act.`,
    confidence: 'high',
    action: 'testkit_dispatch',
    actionFile: `actions/${address.toLowerCase().replace(/\s+/g, '-')}.md`,
    fieldRequestFiled: false,
    baseline: { action: 'testkit_dispatch', confidence: 'high', rationale: 'baseline' },
  };
}

describe('Redactor', () => {
  it('labels addresses in deterministic order', () => {
    const r = new Redactor(['zebra st', 'alpha st']);
    expect(r.label('alpha st')).toBe('Address 1');
    expect(r.label('zebra st')).toBe('Address 2');
  });

  it('redacts text with all known addresses', () => {
    const r = new Redactor(['2214 Genesee St', '436 Mass Ave']);
    const text = 'Visited 2214 Genesee St, then 436 Mass Ave.';
    expect(r.redactText(text)).toBe('Visited Address 1, then Address 2.');
  });

  it('redacts an assessment', () => {
    const r = new Redactor(['2214 Genesee St']);
    const a = makeAssessment('2214 Genesee St');
    a.resolvedAddress = '2214 Genesee St'; // normalized == input
    const out = r.redactAssessment(a, 'actions/redacted-1.md');
    expect(out.address).toBe('Address 1');
    expect(out.resolvedAddress).toBe('Address 1');
    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
    expect(out.agentReasoning).toBe('We evaluated Address 1 and decided to act.');
    expect(out.actionFile).toBe('actions/redacted-1.md');
  });

  it('redacts a whole store', () => {
    const store = new AssessmentStore();
    store.upsert(makeAssessment('2214 Genesee St'));
    store.upsert(makeAssessment('436 Mass Ave'));
    const r = new Redactor(['2214 Genesee St', '436 Mass Ave']);
    const map = new Map([
      ['2214 Genesee St', 'actions/redacted-1.md'],
      ['436 Mass Ave', 'actions/redacted-2.md'],
    ]);
    const out = r.redactStore(store, map);
    const ranked = out.ranked();
    expect(ranked.every((a) => a.address.startsWith('Address '))).toBe(true);
    expect(ranked.every((a) => a.lat === null && a.lng === null)).toBe(true);
  });
});
