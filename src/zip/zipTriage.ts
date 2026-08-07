import type { MireyeClient } from '../mireye/index.js';
import type { CensusClient, TractHousingAge } from '../census.js';
import type { ScoreResult } from '../scorer.js';
import { scoreAddress } from '../scorer.js';
import { toScorerInput } from '../extract.js';
import type { TractFileResolver, TractPoint, ZipTract } from './tractFiles.js';

export interface TractAssessment {
  zipTract: ZipTract;
  point: TractPoint;
  census: TractHousingAge | null;
  score: ScoreResult;
  /** Mireye field provenance (source / fetched_at) for the citation block. */
  provenance: Record<string, { source?: string; fetched_at?: string }>;
}

/**
 * Stage 1 of ZIP mode: score every census tract overlapping the ZIP.
 * Sampling note: contamination/water fields are fetched at the tract's
 * Census internal point — representative, not exhaustive. Stage 2
 * (per-address) is where parcel-level precision happens.
 */
export async function triageZip(
  zip: string,
  deps: {
    mireye: MireyeClient;
    census: CensusClient;
    tractFiles: TractFileResolver;
    /** Skip slivers: tracts covering less than this share of the ZIP's land. */
    minZipLandShare?: number;
  },
): Promise<TractAssessment[]> {
  const { mireye, census, tractFiles } = deps;
  const minShare = deps.minZipLandShare ?? 0.01;

  const zipTracts = (await tractFiles.tractsForZip(zip)).filter(
    (t) => t.zipLandShare >= minShare,
  );
  console.log(`[zip] ${zip} overlaps ${zipTracts.length} tract(s) (>= ${minShare * 100}% land share)`);

  const results: TractAssessment[] = [];
  for (const zipTract of zipTracts) {
    const point = await tractFiles.tractPoint(zipTract.tractGeoid);
    console.log(
      `[zip] tract ${zipTract.tractGeoid} (${(zipTract.zipLandShare * 100).toFixed(0)}% of ZIP) @ ${point.lat},${point.lng}`,
    );
    const [censusResult, mireyeResult] = await Promise.all([
      census.pre1980Share(zipTract.tractGeoid).catch((err: Error) => {
        console.error(`[zip] census failed for ${zipTract.tractGeoid}: ${err.message}`);
        return null;
      }),
      mireye.fetchForPoint(point.lat, point.lng),
    ]);
    const score = scoreAddress(
      toScorerInput(mireyeResult, censusResult?.pre1980Share ?? null),
    );
    const provenance = Object.fromEntries(
      Object.entries(mireyeResult.fields).map(([k, v]) => [
        k,
        { source: v.source, fetched_at: v.fetched_at },
      ]),
    );
    results.push({ zipTract, point, census: censusResult, score, provenance });
  }
  return results.sort((a, b) => b.score.score - a.score.score);
}
