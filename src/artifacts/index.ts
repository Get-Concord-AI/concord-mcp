import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HandoffRecord, Repositories, ReviewRecord, TaskRecord } from '../db/index.js';
import { buildRoster } from '../domain/presence.js';
import { renderEventsJsonl } from './events-jsonl.js';
import { renderHandoffMarkdown } from './handoff-md.js';
import { renderReviewPacketMarkdown } from './review-packet-md.js';
import { renderWorkStateJson } from './work-state-json.js';

export { renderEventsJsonl } from './events-jsonl.js';
export { renderHandoffMarkdown } from './handoff-md.js';
export { renderReviewPacketMarkdown } from './review-packet-md.js';
export { renderWorkStateJson } from './work-state-json.js';

interface HandoffForTask {
  task: TaskRecord;
  handoff: HandoffRecord;
}

interface ReviewForTask {
  task: TaskRecord;
  review: ReviewRecord;
}

function latestHandoff(
  repos: Repositories,
  tasks: readonly TaskRecord[],
): HandoffForTask | undefined {
  let best: HandoffForTask | undefined;
  for (const task of tasks) {
    const handoff = repos.handoffs.latestForTask(task.taskId);
    if (
      handoff !== undefined &&
      (best === undefined || handoff.createdAt >= best.handoff.createdAt)
    ) {
      best = { task, handoff };
    }
  }
  return best;
}

function latestReview(
  repos: Repositories,
  tasks: readonly TaskRecord[],
): ReviewForTask | undefined {
  let best: ReviewForTask | undefined;
  for (const task of tasks) {
    const review = repos.reviews.latestForTask(task.taskId);
    if (review !== undefined && (best === undefined || review.createdAt >= best.review.createdAt)) {
      best = { task, review };
    }
  }
  return best;
}

/**
 * Regenerate all committed/exported artifacts from the database (the source of
 * truth). Called after every tool write so `.concord/` never drifts from the DB.
 * HANDOFF.md and REVIEW_PACKET.md reflect the most recent handoff/review.
 */
export function writeArtifacts(
  concordDirPath: string,
  repos: Repositories,
  generatedAt: string = new Date().toISOString(),
): void {
  mkdirSync(concordDirPath, { recursive: true });
  const tasks = repos.tasks.list();
  const roster = buildRoster(repos.agents.list(), Date.parse(generatedAt));

  writeFileSync(
    join(concordDirPath, 'WORK_STATE.json'),
    renderWorkStateJson(tasks, roster, generatedAt),
  );
  writeFileSync(join(concordDirPath, 'events.jsonl'), renderEventsJsonl(repos.events.list()));

  const handoff = latestHandoff(repos, tasks);
  if (handoff !== undefined) {
    writeFileSync(
      join(concordDirPath, 'HANDOFF.md'),
      renderHandoffMarkdown(handoff.task, handoff.handoff),
    );
  }

  const review = latestReview(repos, tasks);
  if (review !== undefined) {
    writeFileSync(
      join(concordDirPath, 'REVIEW_PACKET.md'),
      renderReviewPacketMarkdown(
        review.task,
        review.review,
        repos.handoffs.latestForTask(review.task.taskId),
      ),
    );
  }
}
