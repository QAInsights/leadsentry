import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ruleBaseline } from './baseline.js';
import { CensusAcsClient, type CensusClient } from './census.js';
import { DemoCensusClient, DemoMireyeClient } from './demo/fixtures.js';
import { toScorerInput, tractGeoidOf } from './extract.js';
import { LEADSENTRY_FIELDS, type MireyeClient } from './mireye/types.js';
import { RateLimitedMireyeClient } from './mireye/rateLimit.js';
import { MireyeRestClient } from './mireye/rest.js';
import { scoreAddress } from './scorer.js';
import type { Assessment } from './store.js';
import { saveLeadScore } from './dynamodb.js';

export const leadScoreRequestSchema = z
  .object({
    address: z.string().trim().min(5).max(300),
  })
  .strict();

export type LeadScoreRequest = z.infer<typeof leadScoreRequestSchema>;

export interface LeadScoreRecord {
  id: string;
  assessedAt: string;
  address: string;
  assessment: Assessment;
}

export interface ScoreLeadDependencies {
  createMireyeClient(demo: boolean): MireyeClient;
  createCensusClient(demo: boolean): CensusClient;
  save(record: LeadScoreRecord): Promise<void>;
  createId(): string;
  now(): Date;
}

function enabled(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? '');
}

function demoRecordId(address: string): string {
  const normalized = address.toLowerCase().replace(/\s+/g, ' ');
  return `demo-${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

const defaultDependencies: ScoreLeadDependencies = {
  createMireyeClient(demo) {
    const token = process.env.MIREYE_API_TOKEN?.trim();
    return demo || !token
      ? new DemoMireyeClient()
      : new RateLimitedMireyeClient(new MireyeRestClient(token));
  },
  createCensusClient(demo) {
    const key = process.env.CENSUS_API_KEY?.trim();
    return demo || !key
      ? new DemoCensusClient()
      : new CensusAcsClient(key, '/tmp/leadsentry-cache');
  },
  save: saveLeadScore,
  createId: randomUUID,
  now: () => new Date(),
};

export async function scoreLead(
  input: LeadScoreRequest,
  dependencies: ScoreLeadDependencies = defaultDependencies,
): Promise<LeadScoreRecord> {
  const request = leadScoreRequestSchema.parse(input);
  const demo = enabled('DEMO_MODE');
  const mireye = dependencies.createMireyeClient(demo);
  const census = dependencies.createCensusClient(demo || mireye.mode === 'demo');

  try {
    const result = await mireye.fetchForAddress(request.address, LEADSENTRY_FIELDS);
    const tractGeoid = tractGeoidOf(result);
    const tract = tractGeoid
      ? await census.pre1980Share(tractGeoid).catch((error: Error) => {
          console.error(`[lambda] census lookup failed for tract ${tractGeoid}: ${error.message}`);
          return null;
        })
      : null;
    const score = scoreAddress(toScorerInput(result, tract?.pre1980Share ?? null));
    const baseline = ruleBaseline(result, score);
    const assessment: Assessment = {
      address: request.address,
      resolvedAddress: result.normalizedAddress,
      lat: result.lat,
      lng: result.lng,
      parcelGrade: result.parcelGrade,
      tractGeoid,
      mireye: result,
      census: tract,
      score,
      agentReasoning: `Score ${score.score}/100 (${score.band}). ${baseline.rationale}`,
      confidence: baseline.confidence,
      action: baseline.action,
      actionFile: null,
      fieldRequestFiled: false,
      baseline,
    };
    const record = {
      id: demo ? demoRecordId(request.address) : dependencies.createId(),
      assessedAt: dependencies.now().toISOString(),
      address: request.address,
      assessment,
    };
    await dependencies.save(record);
    return record;
  } finally {
    await mireye.close();
  }
}
