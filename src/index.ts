import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { connectMireye } from './mireye/index.js';
import { CensusAcsClient, type CensusClient } from './census.js';
import { DemoAddressSampler, DemoCensusClient, DemoTractFiles } from './demo/fixtures.js';
import { AssessmentStore, type Assessment } from './store.js';
import { runAgent } from './agent.js';
import { triageOffline } from './offline.js';
import { ruleBaseline } from './baseline.js';
import { Redactor, redactLetters } from './redact.js';
import { writeReport } from './report.js';
import { writeAddressActions } from './actions.js';
import { resolveModel } from './providers.js';
import { CensusTractFiles } from './zip/tractFiles.js';
import { triageZip } from './zip/zipTriage.js';
import { planZipCanvassing } from './zip/zipAgent.js';
import { writeZipReport, type DeepDiveResult } from './zip/zipReport.js';
import { writeZipActions, assignTiersAndBudget, type TractAction } from './zip/zipActions.js';
import { OsmAddressSampler, type AddressSampler, type SampledAddress } from './zip/addressSampler.js';
import type { TractAssessment } from './zip/zipTriage.js';
import { fetchNysdohRates, type NysdohRecord } from './validate/nysdohClient.js';
import { aggregateZipScore, correlate, type ValidationPoint } from './validate/correlator.js';
import { renderZipValidationSection, writeValidationReport } from './validate/report.js';

interface CliArgs {
  input: string;
  output: string;
  demo: boolean;
  zip: string | null;
  /** Number of addresses to deep-dive in ZIP mode; null means no deep-dive. */
  deep: number | null;
  /** Redact addresses and coordinates from public-facing reports/artifacts. */
  redact: boolean;
  /** Append NYSDOH blood-lead validation to a single ZIP report. */
  validate: boolean;
  /** Run a multi-ZIP validation study from a JSON list of ZIPs. */
  validateZipList: string | null;
  /** NYSDOH year to use for validation; 0 means latest with data. */
  validateYear: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: 'data/sample-addresses.json',
    output: 'report.md',
    demo: false,
    zip: null,
    deep: null,
    redact: false,
    validate: false,
    validateZipList: null,
    validateYear: 0,
  };
  const VALUE_FLAGS = new Set(['--input', '--output', '--zip', '--deep', '--validate-zip-list', '--validate-year']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (VALUE_FLAGS.has(flag)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`Flag "${flag}" requires a value (got "${argv[i + 1] ?? 'nothing'}")`);
      }
      const value = argv[++i];
      if (flag === '--input') args.input = value;
      else if (flag === '--output') args.output = value;
      else if (flag === '--zip') args.zip = value;
      else if (flag === '--validate-zip-list') args.validateZipList = value;
      else if (flag === '--validate-year') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`Flag "--validate-year" requires a non-negative integer (got "${value}")`);
        }
        args.validateYear = n;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`Flag "--deep" requires a positive integer (got "${value}")`);
        }
        args.deep = n;
      }
    } else if (flag === '--demo') {
      args.demo = true;
    } else if (flag === '--redact') {
      args.redact = true;
    } else if (flag === '--validate') {
      args.validate = true;
    } else {
      throw new Error(`Unknown argument "${flag}". Valid flags: --input <path>, --output <path>, --zip <code>, --deep <n>, --validate-zip-list <path>, --validate-year <year>, --validate, --redact, --demo`);
    }
  }
  return args;
}

async function selectTargetTracts(tractActions: TractAction[], n: number): Promise<TractAction[]> {
  // Pick canvass first, then mailer, then any moderate-or-better tract. The
  // input is already ranked by score descending, so the first of each tier is
  // the highest-scoring tract in that tier.
  const canvass = tractActions.filter((a) => a.tier === 'canvass');
  if (canvass.length > 0 && n >= canvass.length) return canvass;
  if (canvass.length > 0) return [canvass[0]];
  const mailers = tractActions.filter((a) => a.tier === 'mailer');
  if (mailers.length > 0) return [mailers[0]];
  const moderate = tractActions.filter((a) => a.tract.score.band !== 'low');
  if (moderate.length > 0) return [moderate[0]];
  return [];
}

async function runDeepDive(
  zip: string,
  deep: number,
  redact: boolean,
  tractActions: TractAction[],
  sampler: AddressSampler,
  config: ReturnType<typeof loadConfig>,
  mireye: Awaited<ReturnType<typeof connectMireye>>,
  census: CensusClient,
): Promise<DeepDiveResult | null> {
  const targets = await selectTargetTracts(tractActions, deep);
  if (targets.length === 0) {
    console.log('[zip] deep-dive: no priority/moderate tracts — stage 2 skipped (negative screen)');
    return null;
  }

  // Allocate requested count across targets deterministically.
  const base = Math.floor(deep / targets.length);
  let remainder = deep - base * targets.length;
  const allocations = targets.map(() => {
    const extra = remainder > 0 ? 1 : 0;
    remainder--;
    return base + extra;
  });

  const all: { sample: SampledAddress; tract: TractAction }[] = [];
  const samples: DeepDiveResult['samples'] = [];
  let offset = 0;
  for (let i = 0; i < targets.length; i++) {
    const tract = targets[i];
    const { addresses, provenance, skippedReason } = await sampler.sampleAddresses(
      tract.tract.zipTract.tractGeoid,
      allocations[i],
      { zip, offset },
    );
    offset += allocations[i];
    samples.push({
      tractGeoid: tract.tract.zipTract.tractGeoid,
      tractName: tract.tract.point.name,
      tier: tract.tier,
      rationale: tract.rationale,
      requested: allocations[i],
      got: addresses.length,
      provenance,
      skippedReason,
    });
    for (const a of addresses) {
      all.push({ sample: a, tract });
    }
  }

  if (all.length === 0) {
    console.log('[zip] deep-dive: no addresses sampled (all samplers skipped)');
    return null;
  }

  const addresses = all.map((a) => a.sample.address);
  const reportPath = `zip-${zip}-deep-report.md`;
  const actionsDir = `actions/zip-${zip}/deep`;
  console.log(`[zip] deep-dive: triaging ${addresses.length} sampled address(es)`);
  const { store } = await runAddressStage2(addresses, config, mireye, census, reportPath, actionsDir, redact);

  return {
    reportPath,
    actionsDir,
    samples,
    ranked: store.ranked(),
  };
}

async function makeZipClients(config: ReturnType<typeof loadConfig>) {
  const mireye = await connectMireye(config.mireyeToken, config.demo);
  const census: CensusClient =
    mireye.mode === 'demo' || !config.censusApiKey
      ? (() => {
          if (!config.demo && !config.censusApiKey) {
            console.log('[census] no CENSUS_API_KEY — falling back to demo fixtures');
          }
          return new DemoCensusClient();
        })()
      : new CensusAcsClient(config.censusApiKey);
  const tractFiles = mireye.mode === 'demo' ? new DemoTractFiles() : new CensusTractFiles();
  return { mireye, census, tractFiles };
}

async function screenZip(
  zip: string,
  config: ReturnType<typeof loadConfig>,
): Promise<{
  tracts: TractAssessment[];
  mireye: Awaited<ReturnType<typeof connectMireye>>;
  census: CensusClient;
}> {
  const { mireye, census, tractFiles } = await makeZipClients(config);
  try {
    const tracts = await triageZip(zip, { mireye, census, tractFiles });
    return { tracts, mireye, census };
  } catch (err) {
    await mireye.close();
    throw err;
  }
}

async function draftCanvassingPlan(
  zip: string,
  tracts: TractAssessment[],
  config: ReturnType<typeof loadConfig>,
): Promise<{ plan: string | null; modelUsed: string | null }> {
  if (!config.llmModel) return { plan: null, modelUsed: null };
  try {
    const model = resolveModel(config.llmModel, config.llmBaseUrl);
    console.log(`[zip] agent drafting canvassing plan with ${config.llmModel}`);
    const plan = await planZipCanvassing(zip, tracts, model);
    return { plan, modelUsed: config.llmModel };
  } catch (err) {
    console.error(`[zip] plan step failed (${(err as Error).message.slice(0, 200)}) — report will omit it`);
    return { plan: null, modelUsed: null };
  }
}

async function runZipMode(
  zip: string,
  deep: number | null,
  redact: boolean,
  config: ReturnType<typeof loadConfig>,
  output: string,
  validate = false,
  validateYear = 0,
): Promise<void> {
  const { tracts, mireye, census } = await screenZip(zip, config);
  try {
    const { plan, modelUsed } = await draftCanvassingPlan(zip, tracts, config);
    const tractActions = assignTiersAndBudget(tracts);
    const sampler: AddressSampler =
      mireye.mode === 'demo' ? new DemoAddressSampler() : new OsmAddressSampler();
    const deepResult = deep
      ? await runDeepDive(zip, deep, redact, tractActions, sampler, config, mireye, census)
      : null;

    const out = output === 'report.md' ? `zip-${zip}-report.md` : output;
    let validationSection: string | null = null;
    if (validate) {
      const record = await nysdohRecordForZip(zip, validateYear);
      const point = record ? buildValidationPoint(zip, tracts, record) : null;
      validationSection = renderZipValidationSection(point);
    }
    await writeZipReport(zip, tracts, plan, out, {
      mode: mireye.mode === 'demo' ? 'demo' : plan ? 'agent-plan' : 'tract-triage',
      model: modelUsed,
      deepResult,
      validationSection,
    });
    const actionsDir = await writeZipActions(zip, tracts);
    console.log(`[zip] wrote ${out}`);
    console.log(`[zip] action artifacts in ${actionsDir}/ (csv, geojson, operator checklist)`);
    for (const t of tracts) {
      console.log(
        `  ${String(t.score.score).padStart(3)}  ${t.score.band}  tract ${t.zipTract.tractGeoid}  (${(t.zipTract.zipLandShare * 100).toFixed(0)}% of ZIP, pre-1980 ${t.census ? (t.census.pre1980Share * 100).toFixed(0) + '%' : 'n/a'})`,
      );
    }
  } finally {
    await mireye.close();
  }
}

async function nysdohRecordForZip(zip: string, year = 0): Promise<NysdohRecord | null> {
  const map = await fetchNysdohRates([zip], year > 0 ? { year } : {});
  return map.get(zip) ?? null;
}

function buildValidationPoint(zip: string, tracts: TractAssessment[], record: NysdohRecord): ValidationPoint {
  const summary = aggregateZipScore(zip, tracts);
  return {
    zip,
    leadSentryMax: summary.maxScore,
    leadSentryMean: summary.weightedMeanScore,
    priorityLandShare: summary.priorityLandShare,
    nysdohRate: record.ratePer1000,
    nysdohTests: record.tests,
    nysdohEblls: record.totalEblls,
    nysdohYear: record.year,
  };
}

async function runValidationStudy(
  zipListPath: string,
  validateYear: number,
  config: ReturnType<typeof loadConfig>,
  output: string,
): Promise<void> {
  const zips = JSON.parse(await readFile(zipListPath, 'utf8')) as string[];
  if (!Array.isArray(zips) || zips.length === 0) {
    throw new Error(`ZIP list ${zipListPath} must be a non-empty JSON array of strings`);
  }
  console.log(`[validate] running validation study across ${zips.length} ZIP(s) from ${zipListPath}`);

  const summaries: ReturnType<typeof aggregateZipScore>[] = [];
  for (let i = 0; i < zips.length; i++) {
    const zip = zips[i];
    console.log(`[validate] [${i + 1}/${zips.length}] screening ZIP ${zip}`);
    const { tracts, mireye } = await screenZip(zip, config);
    try {
      summaries.push(aggregateZipScore(zip, tracts));
    } finally {
      await mireye.close();
    }
  }

  console.log('[validate] fetching NYSDOH blood-lead data');
  const nysdoh = await fetchNysdohRates(zips, validateYear > 0 ? { year: validateYear } : {});

  const result = correlate(summaries, nysdoh);
  const out = output === 'report.md' ? 'validation-report.md' : output;
  await writeValidationReport(result, out);
  console.log(`[validate] wrote ${out}`);

  for (const c of result.correlations) {
    console.log(
      `[validate] ${c.metric}: Pearson ${c.pearson?.toFixed(2) ?? 'n/a'}, Spearman ${c.spearman?.toFixed(2) ?? 'n/a'} (n=${c.n})`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.demo);

  if (args.validateZipList) {
    await runValidationStudy(args.validateZipList, args.validateYear, config, args.output);
    return;
  }

  if (args.zip) {
    await runZipMode(args.zip, args.deep, args.redact, config, args.output, args.validate, args.validateYear);
    return;
  }

  const addresses = JSON.parse(await readFile(args.input, 'utf8')) as string[];
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`Input file ${args.input} must be a non-empty JSON array of addresses`);
  }
  console.log(`[leadsentry] triaging ${addresses.length} address(es) from ${args.input}`);

  const mireye = await connectMireye(config.mireyeToken, config.demo);
  const census: CensusClient =
    mireye.mode === 'demo' || !config.censusApiKey
      ? (() => {
          if (!config.demo && !config.censusApiKey) {
            console.log('[census] no CENSUS_API_KEY — falling back to demo fixtures');
          }
          return new DemoCensusClient();
        })()
      : new CensusAcsClient(config.censusApiKey);

  try {
    await runAddressStage2(addresses, config, mireye, census, args.output, 'actions', args.redact);
  } finally {
    await mireye.close();
  }
}

async function runAddressStage2(
  addresses: string[],
  config: ReturnType<typeof loadConfig>,
  mireye: Awaited<ReturnType<typeof connectMireye>>,
  census: CensusClient,
  outputPath: string,
  actionsDir: string,
  redact = false,
): Promise<{ store: AssessmentStore; engine: string; modelUsed: string | null }> {
  const store = new AssessmentStore();
  let engine = 'offline-triage';
  let modelUsed: string | null = null;

  if (config.llmModel) {
    try {
      const model = resolveModel(config.llmModel, config.llmBaseUrl);
      console.log(`[agent] running triage agent with ${config.llmModel}`);
      const agentRun = await runAgent(addresses, { model, mireye, census, store });
      console.log(`[agent] summary: ${agentRun.text.slice(0, 400)}`);
      console.log(`[agent] token usage: ${JSON.stringify(agentRun.usage)}`);
      engine = 'agent';
      modelUsed = config.llmModel;
    } catch (err) {
      console.error(
        `[agent] agent loop failed (${(err as Error).message.slice(0, 300)}) — falling back to offline triage`,
      );
    }
  } else {
    console.log('[leadsentry] no LLM_MODEL set — running offline triage (rule-based)');
  }

  // Complete any address the agent didn't fully decide on.
  const missing = addresses.filter((a) => {
    const entry = store.get(a);
    return !entry?.score || entry.agentReasoning === '';
  });
  if (missing.length > 0) {
    console.log(`[leadsentry] completing ${missing.length} address(es) via offline triage`);
    await triageOffline(missing, mireye, census, store);
  }

  // Compute rule baseline post-hoc for every assessment. The agent never saw
  // this during its loop, so the comparison is fair and the model can't anchor.
  applyBaseline(store);

  // If requested, redact PII before writing public-facing reports/artifacts.
  let reportStore = store;
  if (redact) {
    const redactor = new Redactor(addresses);
    const actionFileMap = await redactLetters(redactor, store, actionsDir);
    reportStore = redactor.redactStore(store, actionFileMap);
    console.log('[leadsentry] redacted addresses and coordinates from outputs');
  }

  await writeReport(reportStore, outputPath, { mode: engine, model: modelUsed });
  const ranked = reportStore.ranked();
  console.log(`[leadsentry] wrote ${outputPath}`);
  for (const a of ranked) {
    console.log(
      `  ${String(a.score?.score ?? '?').padStart(3)}  ${a.score?.band ?? '?'}  ${a.address}  -> ${a.action}`,
    );
  }

  const outActionsDir = await writeAddressActions(reportStore, actionsDir);
  console.log(
    `[leadsentry] action artifacts in ${outActionsDir}/ (address-actions.csv, address-points.geojson, operator-checklist.md)`,
  );

  return { store: reportStore, engine, modelUsed };
}

function applyBaseline(store: AssessmentStore): void {
  for (const a of store.all()) {
    if (a.baseline || !a.mireye || !a.score) continue;
    a.baseline = ruleBaseline(a.mireye, a.score);
    store.upsert(a);
  }
}

main().catch((err) => {
  console.error(`[leadsentry] fatal: ${(err as Error).message}`);
  process.exit(1);
});
