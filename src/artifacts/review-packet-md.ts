import type { HandoffRecord, ReviewRecord, TaskRecord } from '../db/index.js';
import { bulletList, codeBulletList } from './markdown.js';

function renderProvenance(review: ReviewRecord): string {
  if (review.provenance.length === 0) {
    return '_None_';
  }
  return review.provenance.map((entry) => `- ${entry.field}: ${entry.source}`).join('\n');
}

/**
 * Render a REVIEW_PACKET.md combining the task, its latest review packet, and
 * (when available) its latest handoff for changed files and decisions.
 */
export function renderReviewPacketMarkdown(
  task: TaskRecord,
  review: ReviewRecord,
  handoff: HandoffRecord | undefined,
): string {
  const filesTouched = handoff?.changedFiles ?? task.expectedFiles;
  const decisions = handoff?.decisions ?? [];

  return [
    `# Review Packet: ${task.taskId} — ${task.title}`,
    '',
    '## Plan',
    '',
    review.planSummary,
    '',
    '## Files touched',
    '',
    codeBulletList(filesTouched),
    '',
    '## Guardrails checked',
    '',
    bulletList(review.guardrailsChecked),
    '',
    '## Decisions',
    '',
    bulletList(decisions),
    '',
    '## Tests run',
    '',
    codeBulletList(review.testsRun),
    '',
    '## Assumptions',
    '',
    bulletList(review.assumptions),
    '',
    '## Diff size',
    '',
    review.diffSize ?? '_Unknown_',
    '',
    '## Open questions',
    '',
    bulletList(review.openQuestions),
    '',
    '## Provenance',
    '',
    renderProvenance(review),
    '',
  ].join('\n');
}
