import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Assessment, ActionType } from './store.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function slug(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Writes the concrete follow-up artifact an agent decided on:
 * outreach letter, test-kit dispatch entry, or monitoring-list line.
 * Output goes to actions/ so a health department can act on it directly.
 */
export async function writeAction(
  assessment: Assessment,
  action: ActionType,
  actionsDir = 'actions',
): Promise<string | null> {
  if (action === 'none') return null;
  await mkdir(actionsDir, { recursive: true });

  const score = assessment.score?.score ?? 'n/a';
  const band = assessment.score?.band ?? 'unknown';

  if (action === 'outreach_letter' || action === 'priority_outreach') {
    const file = join(actionsDir, `${slug(assessment.address)}.md`);
    const topDrivers =
      assessment.score?.components
        .filter((c) => c.points > 0)
        .map((c) => `- ${c.reason} (${c.points}/${c.maxPoints} pts — ${c.source})`)
        .join('\n') ?? '- (no scored components)';
    const letter = `# ${action === 'priority_outreach' ? 'PRIORITY ' : ''}Lead-Safety Outreach — DRAFT

**To:** Resident, ${assessment.address}
**Risk score:** ${score}/100 (${band})
**Prepared:** ${new Date().toISOString().slice(0, 10)}

Dear Resident,

Our screening program has identified your home as having an elevated risk of
lead exposure${assessment.census ? ` — ${(assessment.census.pre1980Share * 100).toFixed(0)}% of homes in your census tract were built before 1980, when lead paint was still in use` : ''}.
Lead exposure is most dangerous for children under 6 and is entirely
preventable once identified.

**What we are offering, at no cost to you:**
1. A free lead test kit for your home's water and painted surfaces.
2. A free water filter certified for lead removal, if you want one.
3. Information on free blood-lead testing for children under 6.

To schedule, reply to this letter or call the county health department.

---
*Risk factors identified (with sources):*
${topDrivers}
`;
    await writeFile(file, letter);
    return file;
  }

  if (action === 'testkit_dispatch' || action === 'monitoring_list') {
    const file = join(actionsDir, 'dispatch-list.md');
    const line = `| ${assessment.address} | ${score} | ${band} | ${action === 'testkit_dispatch' ? 'test kit + filter' : 'monitor'} | ${assessment.confidence} |\n`;
    if (!(await exists(file))) {
      await writeFile(
        file,
        '# Test-Kit Dispatch & Monitoring List\n\n| Address | Score | Band | Action | Confidence |\n|---|---|---|---|---|\n',
      );
    }
    await appendFile(file, line);
    return file;
  }

  return null;
}
