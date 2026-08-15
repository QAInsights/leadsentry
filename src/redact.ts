import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AssessmentStore, type Assessment } from './store.js';

/**
 * PII redaction for public-facing reports and artifacts.
 *
 * When `--redact` is passed, all real addresses are replaced by neutral
 * `Address N` labels, lat/lng coordinates are nulled, and per-address letters
 * are rewritten with redacted file names and content. Census tract geoids and
 * score components are preserved — they are public data and useful for judging.
 */

export class Redactor {
  private readonly labels = new Map<string, string>();

  constructor(addresses: string[]) {
    const sorted = [...addresses].sort((a, b) => a.localeCompare(b));
    sorted.forEach((address, i) => {
      this.labels.set(address, `Address ${i + 1}`);
    });
  }

  label(address: string): string {
    return this.labels.get(address) ?? address;
  }

  redactText(text: string): string {
    let out = text;
    // Replace longest addresses first to avoid shorter ones matching inside longer ones.
    const entries = [...this.labels.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [original, label] of entries) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Partial-match guard: don't replace an address when it appears inside a
      // longer word (e.g. "Main" inside "Maine"). Embedded multi-word addresses
      // inside longer addresses (e.g. "123 Main St" inside "123 Main St Apt 4")
      // are still mitigated by the length-descending order; the longer variant
      // is redacted first when it is in the label set.
      const re = new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'gi');
      out = out.replace(re, label);
    }
    return out;
  }

  redactAssessment(a: Assessment, actionFile?: string | null): Assessment {
    const redacted = this.label(a.address);
    const resolved = a.resolvedAddress ? this.redactText(a.resolvedAddress) : a.resolvedAddress;
    return {
      ...a,
      address: redacted,
      resolvedAddress: resolved,
      lat: null,
      lng: null,
      agentReasoning: this.redactText(a.agentReasoning),
      actionFile: actionFile ?? a.actionFile,
    };
  }

  redactStore(store: AssessmentStore, actionFileMap?: Map<string, string>): AssessmentStore {
    const out = new AssessmentStore();
    for (const a of store.all()) {
      const newFile = actionFileMap?.get(a.address) ?? a.actionFile;
      out.upsert(this.redactAssessment(a, newFile));
    }
    return out;
  }
}

/**
 * Redact per-address markdown letters in place.
 *
 * For each assessment whose actionFile points to a `.md` in `actionsDir`,
 * renames the file to `redacted-N.md` and replaces address occurrences in the
 * file body. Returns a map from original address -> new actionFile path.
 */
export async function redactLetters(
  redactor: Redactor,
  store: AssessmentStore,
  actionsDir: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const a of store.all()) {
    if (!a.actionFile?.endsWith('.md')) continue;
    if (basename(a.actionFile).toLowerCase() === 'dispatch-list.md') continue;

    const originalPath = a.actionFile;
    const label = redactor.label(a.address);
    const safeLabel = label.toLowerCase().replace(/\s+/g, '-');
    const newPath = join(dirname(originalPath), `${safeLabel}.md`);

    const raw = await readFile(originalPath, 'utf8');
    const redacted = redactor.redactText(raw);
    await writeFile(newPath, redacted);
    map.set(a.address, newPath);

    if (newPath !== originalPath) {
      // Best-effort cleanup of the original file; ignore errors.
      await rm(originalPath, { force: true }).catch(() => {});
    }
  }
  return map;
}
