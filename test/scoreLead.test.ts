import { describe, expect, it, vi } from 'vitest';
import { DemoCensusClient, DemoMireyeClient } from '../src/demo/fixtures.js';
import { scoreLead, type LeadScoreRecord, type ScoreLeadDependencies } from '../src/scoreLead.js';

const address = '436 Massachusetts Ave, Buffalo, NY 14213';

describe('scoreLead', () => {
  it('runs the existing scorer and persists the assessment', async () => {
    const mireye = new DemoMireyeClient();
    const close = vi.spyOn(mireye, 'close');
    let saved: LeadScoreRecord | undefined;
    const dependencies: ScoreLeadDependencies = {
      createMireyeClient: () => mireye,
      createCensusClient: () => new DemoCensusClient(),
      save: async (record) => {
        saved = record;
      },
      createId: () => 'assessment-1',
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    };

    const record = await scoreLead({ address }, dependencies);

    expect(record).toMatchObject({
      id: 'assessment-1',
      assessedAt: '2026-08-20T12:00:00.000Z',
      address,
      assessment: {
        address,
        tractGeoid: '36029006500',
        action: 'testkit_dispatch',
        confidence: 'high',
        score: { band: 'priority' },
      },
    });
    expect(record.assessment.score?.score).toBeGreaterThan(30);
    expect(saved).toEqual(record);
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses a stable record ID and demo census client in demo mode', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const createId = vi.fn(() => 'random-id');
    const createCensusClient = vi.fn(() => new DemoCensusClient());
    const dependencies: ScoreLeadDependencies = {
      createMireyeClient: () => new DemoMireyeClient(),
      createCensusClient,
      save: async () => {},
      createId,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    };

    const first = await scoreLead({ address }, dependencies);
    const second = await scoreLead({ address: `  ${address}  ` }, dependencies);

    expect(first.id).toMatch(/^demo-[a-f0-9]{24}$/);
    expect(second.id).toBe(first.id);
    expect(createId).not.toHaveBeenCalled();
    expect(createCensusClient).toHaveBeenCalledWith(true);
    vi.unstubAllEnvs();
  });

  it('closes the Mireye client when persistence fails', async () => {
    const mireye = new DemoMireyeClient();
    const close = vi.spyOn(mireye, 'close');
    const dependencies: ScoreLeadDependencies = {
      createMireyeClient: () => mireye,
      createCensusClient: () => new DemoCensusClient(),
      save: async () => {
        throw new Error('DynamoDB unavailable');
      },
      createId: () => 'assessment-1',
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    };

    await expect(scoreLead({ address }, dependencies)).rejects.toThrow('DynamoDB unavailable');
    expect(close).toHaveBeenCalledOnce();
  });
});
