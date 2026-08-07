import type { MireyeFetchResult } from './mireye/types.js';
import type { TractHousingAge } from './census.js';
import type { ScoreResult } from './scorer.js';

export type Confidence = 'high' | 'medium' | 'low';
export type ActionType =
  | 'outreach_letter'
  | 'testkit_dispatch'
  | 'priority_outreach'
  | 'monitoring_list'
  | 'none';

export interface Assessment {
  address: string;
  resolvedAddress: string | null;
  lat: number | null;
  lng: number | null;
  parcelGrade: boolean | null;
  tractGeoid: string | null;
  mireye: MireyeFetchResult | null;
  census: TractHousingAge | null;
  score: ScoreResult | null;
  /** The agent's own reasoning for this address — the "decides" part. */
  agentReasoning: string;
  confidence: Confidence;
  action: ActionType;
  actionFile: string | null;
  fieldRequestFiled: boolean;
}

/** In-memory run store; the agent fills this via the record_assessment tool. */
export class AssessmentStore {
  private readonly byAddress = new Map<string, Assessment>();

  upsert(a: Assessment): void {
    this.byAddress.set(a.address, a);
  }

  get(address: string): Assessment | undefined {
    return this.byAddress.get(address);
  }

  all(): Assessment[] {
    return [...this.byAddress.values()];
  }

  ranked(): Assessment[] {
    return this.all().sort((x, y) => (y.score?.score ?? -1) - (x.score?.score ?? -1));
  }
}
