import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { connectMireye } from './mireye/index.js';
import { CensusAcsClient, type CensusClient } from './census.js';
import { DemoCensusClient, DemoTractFiles } from './demo/fixtures.js';
import { AssessmentStore } from './store.js';
import { runAgent } from './agent.js';
import { triageOffline } from './offline.js';
import { writeReport } from './report.js';
import { resolveModel } from './providers.js';
import { CensusTractFiles } from './zip/tractFiles.js';
import { triageZip } from './zip/zipTriage.js';
import { planZipCanvassing } from './zip/zipAgent.js';
import { writeZipReport } from './zip/zipReport.js';
import { writeZipActions } from './zip/zipActions.js';

interface CliArgs {
  input: string;
  output: string;
  demo: boolean;
  zip: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: 'data/sample-addresses.json',
    output: 'report.md',
    demo: false,
    zip: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (argv[i] === '--zip' && argv[i + 1]) args.zip = argv[++i];
    else if (argv[i] === '--demo') args.demo = true;
  }
  return args;
}

async function runZipMode(zip: string, config: ReturnType<typeof loadConfig>, output: string): Promise<void> {
  const mireye = await connectMireye(config.mireyeToken, config.demo);
  try {
    const census: CensusClient =
      mireye.mode === 'demo' || !config.censusApiKey
        ? new DemoCensusClient()
        : new CensusAcsClient(config.censusApiKey);
    const tractFiles = mireye.mode === 'demo' ? new DemoTractFiles() : new CensusTractFiles();

    const tracts = await triageZip(zip, { mireye, census, tractFiles });

    let plan: string | null = null;
    let modelUsed: string | null = null;
    if (config.llmModel) {
      try {
        const model = resolveModel(config.llmModel, config.llmBaseUrl);
        console.log(`[zip] agent drafting canvassing plan with ${config.llmModel}`);
        plan = await planZipCanvassing(zip, tracts, model);
        modelUsed = config.llmModel;
      } catch (err) {
        console.error(`[zip] plan step failed (${(err as Error).message.slice(0, 200)}) — report will omit it`);
      }
    }

    const out = output === 'report.md' ? `zip-${zip}-report.md` : output;
    await writeZipReport(zip, tracts, plan, out, {
      mode: mireye.mode === 'demo' ? 'demo' : plan ? 'agent-plan' : 'tract-triage',
      model: modelUsed,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.demo);

  if (args.zip) {
    await runZipMode(args.zip, config, args.output);
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

  const store = new AssessmentStore();
  let engine = 'offline-triage';
  let modelUsed: string | null = null;

  try {
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

    // Complete any address the agent didn't fully decide on (a score without
    // a recorded assessment means the model never finished that address).
    // In offline mode the store starts empty, so this covers everything.
    const missing = addresses.filter((a) => {
      const entry = store.get(a);
      return !entry?.score || entry.agentReasoning === '';
    });
    if (missing.length > 0) {
      console.log(`[leadsentry] completing ${missing.length} address(es) via offline triage`);
      await triageOffline(missing, mireye, census, store);
    }

    await writeReport(store, args.output, { mode: engine, model: modelUsed });
    const ranked = store.ranked();
    console.log(`[leadsentry] wrote ${args.output}`);
    for (const a of ranked) {
      console.log(
        `  ${String(a.score?.score ?? '?').padStart(3)}  ${a.score?.band ?? '?'}  ${a.address}  -> ${a.action}`,
      );
    }
  } finally {
    await mireye.close();
  }
}

main().catch((err) => {
  console.error(`[leadsentry] fatal: ${(err as Error).message}`);
  process.exit(1);
});
