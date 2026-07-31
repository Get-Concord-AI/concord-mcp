import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { startWorkspaceAgentRelay } from '../../dist/relay/index.js';

const role = process.argv[2];
if (!['fe', 'be', 'review'].includes(role)) {
  throw new Error('Usage: node agent.mjs <fe|be|review>');
}

const demoDir = process.cwd();
const sourceRoot = process.env['CONCORD_SOURCE_ROOT'];
if (sourceRoot === undefined) throw new Error('CONCORD_SOURCE_ROOT is required');

const serverEntry = join(sourceRoot, 'dist', 'index.js');
const speed = Number.parseFloat(process.env['DEMO_SPEED'] ?? '1');
const agent = {
  fe: {
    id: 'claude:frontend',
    kind: 'claude-code',
    label: 'CLAUDE · FRONTEND',
    color: '\u001B[36m',
  },
  be: { id: 'codex:backend', kind: 'codex', label: 'CODEX · BACKEND', color: '\u001B[38;5;208m' },
  review: {
    id: 'claude:reviewer',
    kind: 'claude-code',
    label: 'CLAUDE · REVIEWER',
    color: '\u001B[35m',
  },
}[role];

const reset = '\u001B[0m';
const dim = '\u001B[2m';
const green = '\u001B[32m';
const yellow = '\u001B[33m';
let relay;
let promptMessageId;
let replyReceived = false;

const runtimeFiles = {
  'src/app/page.tsx': String.raw`'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const CELLS = 9;
const ROUND_SECONDS = 20;
type Score = { id: number; name: string; score: number };

export default function Home() {
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [score, setScore] = useState(0);
  const [seconds, setSeconds] = useState(ROUND_SECONDS);
  const [mole, setMole] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [leaders, setLeaders] = useState<Score[]>([]);
  const [message, setMessage] = useState('');
  const moleRef = useRef<number | null>(null);

  const moveMole = useCallback(() => {
    const next = Math.floor(Math.random() * CELLS);
    moleRef.current = next === moleRef.current ? (next + 1) % CELLS : next;
    setMole(moleRef.current);
  }, []);
  const loadLeaders = useCallback(async () => {
    const response = await fetch('/api/scores', { cache: 'no-store' });
    if (response.ok) setLeaders((await response.json()).scores ?? []);
  }, []);
  const endRound = useCallback(() => {
    moleRef.current = null;
    setMole(null);
    setPlaying(false);
    setFinished(true);
    void loadLeaders();
  }, [loadLeaders]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setSeconds((current) => {
      if (current <= 1) {
        queueMicrotask(endRound);
        return 0;
      }
      return current - 1;
    }), 1000);
    const movement = setInterval(moveMole, 650);
    return () => { clearInterval(timer); clearInterval(movement); };
  }, [endRound, moveMole, playing]);

  function startRound() {
    setScore(0); setSeconds(ROUND_SECONDS); setFinished(false); setMessage('');
    setPlaying(true); moveMole();
  }
  function whack(index: number) {
    if (playing && moleRef.current === index) {
      setScore((current) => current + 1);
      moveMole();
    }
  }
  async function submitScore() {
    setMessage('Saving…');
    const response = await fetch('/api/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || 'Anonymous', score }),
    });
    const data = await response.json();
    setMessage(response.ok ? 'Saved — you’re #' + String(data.rank) + '!' : data.error);
    if (response.ok) await loadLeaders();
  }

  return <main className="game">
    <header><div className="badge">BUILT LIVE BY TWO AGENTS</div><h1>Whack-a-Mole</h1>
      <p>Concord caught the collision. You get the game.</p></header>
    <section className="scorebar"><div><span>Score</span><strong>{score}</strong></div>
      <div><span>Time</span><strong>{seconds}s</strong></div></section>
    <section className="grid" aria-label="Whack-a-Mole board">
      {Array.from({ length: CELLS }, (_, index) => <button key={index} type="button"
        className={'hole' + (mole === index && playing ? ' hole--active' : '')}
        onClick={() => whack(index)} aria-label={mole === index && playing ? 'Whack the mole' : 'Empty hole'}>
        <span>{mole === index && playing ? '🐹' : ''}</span></button>)}
    </section>
    {!playing && !finished && <button className="primary" onClick={startRound}>Start game</button>}
    {playing && <button className="secondary" onClick={endRound}>End round</button>}
    {finished && <section className="result"><h2>You scored {score}</h2><div className="submit">
      <input value={name} maxLength={24} placeholder="Your name" onChange={(event) => setName(event.target.value)} />
      <button className="primary" onClick={() => void submitScore()}>Submit score</button>
      <button className="secondary" onClick={startRound}>Play again</button></div><p className="message">{message}</p>
      {leaders.length > 0 && <ol className="leaders">{leaders.map((leader, index) => <li key={leader.id}>
        <b>#{index + 1}</b><span>{leader.name}</span><strong>{leader.score}</strong></li>)}</ol>}</section>}
  </main>;
}
`,
  'src/app/globals.css': String.raw`:root { --ink:#f8f6ef; --muted:#b9bdd0; --yellow:#ffd166; }
* { box-sizing: border-box; } html, body { margin: 0; min-height: 100%; }
body { min-height: 100vh; color:var(--ink); font-family:ui-rounded,system-ui,sans-serif;
  background:radial-gradient(circle at 30% 10%,#26376d,transparent 36%),linear-gradient(145deg,#11172d,#301b4e); }
button, input { font: inherit; } .game { min-height:100vh; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:18px; padding:26px 18px 44px; }
header { text-align:center; } .badge { color:var(--yellow); font-size:11px; font-weight:900; letter-spacing:.18em; }
h1 { margin:7px 0 0; font-size:clamp(42px,7vw,68px); line-height:1; } header p { margin:8px 0 0; color:var(--muted); }
.scorebar { display:flex; width:min(440px,92vw); gap:12px; } .scorebar div { flex:1; display:flex; justify-content:space-between;
  align-items:baseline; padding:11px 16px; border:1px solid #ffffff1f; border-radius:14px; background:#ffffff12; }
.scorebar span { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.1em; }
.scorebar strong { font-size:25px; } .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; width:min(440px,92vw); }
.hole { position:relative; aspect-ratio:1; border:1px solid #ffffff17; border-radius:20px; background:#0000003d; cursor:pointer; overflow:hidden; }
.hole::after { content:""; position:absolute; left:13%; right:13%; bottom:14%; height:24%; border-radius:50%; background:#171027; box-shadow:inset 0 7px 12px #000b; }
.hole span { position:relative; z-index:2; display:block; font-size:clamp(35px,8vw,62px); transform:translateY(125%); opacity:0; transition:.13s; }
.hole--active { box-shadow:0 0 0 2px #ffd16659,0 15px 30px #0000004d; } .hole--active span { transform:translateY(5%); opacity:1; }
.primary,.secondary { border:0; border-radius:999px; padding:12px 21px; font-weight:850; cursor:pointer; }
.primary { background:var(--yellow); color:#21162d; } .secondary { background:#ffffff1f; color:var(--ink); }
.result { width:min(520px,94vw); text-align:center; padding:18px; border-radius:20px; background:#0003; }
.result h2 { margin:0 0 12px; } .submit { display:flex; justify-content:center; gap:8px; flex-wrap:wrap; }
input { min-width:150px; border:1px solid #ffffff29; border-radius:999px; padding:11px 15px; color:var(--ink); background:#00000040; outline:none; }
.message { min-height:20px; margin:10px 0; color:var(--yellow); } .leaders { max-width:360px; margin:10px auto 0; padding:0; list-style:none; }
.leaders li { display:grid; grid-template-columns:42px 1fr auto; gap:8px; padding:8px 10px; text-align:left; border-top:1px solid #ffffff14; }
.leaders b { color:var(--yellow); }
`,
  'src/lib/scores.ts': String.raw`export interface ScoreEntry { id: number; name: string; score: number; }
export interface ScoreInput { name: string; score: number; }
const scores: ScoreEntry[] = []; let nextId = 1;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validateScore(value: unknown): { data?: ScoreInput; error?: string } {
  if (!isRecord(value) || typeof value['name'] !== 'string') return { error: 'Name is required.' };
  const name = value['name'].trim();
  if (name.length < 1 || name.length > 24) return { error: 'Name must be 1–24 characters.' };
  if (typeof value['score'] !== 'number' || !Number.isSafeInteger(value['score']) || value['score'] < 0) {
    return { error: 'Score must be a non-negative integer.' };
  }
  return { data: { name, score: value['score'] } };
}
export function addScore(input: ScoreInput): { entry: ScoreEntry; rank: number } {
  const entry = { id: nextId++, ...input }; scores.push(entry);
  scores.sort((left, right) => right.score - left.score || left.id - right.id);
  return { entry, rank: scores.findIndex((score) => score.id === entry.id) + 1 };
}
export function topScores(): ScoreEntry[] { return scores.slice(0, 10); }
`,
  'src/app/api/scores/route.ts': String.raw`import { addScore, topScores, validateScore } from '@/lib/scores';
export const dynamic = 'force-dynamic';
export function GET() { return Response.json({ scores: topScores() }); }
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'Request body must be JSON.' }, { status: 400 }); }
  const result = validateScore(body);
  if (result.data === undefined) return Response.json({ error: result.error }, { status: 400 });
  const saved = addScore(result.data);
  return Response.json({ score: saved.entry, rank: saved.rank }, { status: 201 });
}
`,
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds * speed)));
}

function line(message = '') {
  process.stdout.write(`${message}\n`);
}

async function beat(message) {
  line(`${agent.color}${message}${reset}`);
  await sleep(650);
}

function toolLabel(name, detail) {
  line(`${dim}→ MCP ${name}${detail === undefined ? '' : ` · ${detail}`}${reset}`);
}

function resultText(result) {
  const first = result.content?.[0];
  if (first?.type !== 'text') return '';
  const lines = first.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: demoDir,
  env: {
    ...process.env,
    CONCORD_REPO_ROOT: demoDir,
    CONCORD_NO_UPDATE_CHECK: '1',
  },
});
const client = new Client({ name: `concord-demo-${role}`, version: '1.0.0' });
await client.connect(transport);

async function call(name, args, detail) {
  toolLabel(name, detail);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${resultText(result)}`);
  }
  line(`${green}✓ ${resultText(result)}${reset}`);
  await sleep(500);
  return result;
}

async function inspectTask(taskId) {
  return call('inspect_work', { task_id: taskId }, taskId);
}

async function waitForTask(taskId, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'inspect_work', arguments: { task_id: taskId } });
    if (result.isError !== true && predicate(result.structuredContent?.task)) return result;
    await sleep(350);
  }
  throw new Error(`Timed out waiting for ${taskId}`);
}

async function waitForPromptable(agentId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: 'inspect_work',
      arguments: { agent_id: agentId },
    });
    if (result.structuredContent?.promptable === true) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${agentId} relay`);
}

function install(relativePaths) {
  for (const relativePath of relativePaths) {
    const destination = join(demoDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, runtimeFiles[relativePath]);
  }
}

async function startRelay() {
  const address = join(demoDir, '.concord', `${role}.sock`);
  relay = await startWorkspaceAgentRelay({
    repoRoot: demoDir,
    agentId: agent.id,
    address,
    hasActiveTurn: () => true,
    adapter: {
      provider: role === 'be' ? 'codex' : 'claude',
      async steer(delivery) {
        line();
        line(`${yellow}⚡ LIVE PROMPT from ${delivery.senderAgentId}${reset}`);
        line(`${yellow}${delivery.content.split('\n')[1] ?? delivery.content}${reset}`);
        if (role === 'fe' && delivery.senderAgentId === 'codex:backend') {
          promptMessageId = delivery.messageId;
          setTimeout(() => {
            void call(
              'update_work',
              {
                operation: 'reply',
                agent_id: agent.id,
                reply_to_message_id: delivery.messageId,
                content:
                  'Confirmed: I own the page and game state; you own /api/scores. I will accept your handoff before finishing.',
                idempotency_key: `frontend-reply-${delivery.messageId}`,
              },
              'reply after acknowledging the live delivery',
            ).catch((error) => {
              line(`\u001B[31m✗ live reply failed: ${String(error)}${reset}`);
            });
          }, 75);
        }
        if (role === 'be' && delivery.senderAgentId === 'claude:frontend') {
          replyReceived = true;
        }
        return `${role}-turn-live`;
      },
      async startTurn(delivery) {
        return this.steer(delivery);
      },
    },
  });
  line(`${dim}● live Concord relay connected — prompts can interrupt this turn${reset}`);
}

async function frontend() {
  await beat('Claiming the game UI before I edit…');
  await call(
    'start_work',
    {
      task_id: 'TASK-FE',
      title: 'Build the Whack-a-Mole game UI',
      kind: agent.kind,
      agent_id: agent.id,
      model: 'claude-sonnet',
      cwd: demoDir,
      pid: process.pid,
      expected_files: ['src/app/page.tsx', 'src/app/globals.css'],
      modules: ['frontend', 'game-state'],
      risk_tags: ['shared-game-contract'],
      notes: 'Own the interactive board, timer, and score submission UI.',
    },
    'claim frontend + shared game state',
  );
  await startRelay();

  await call(
    'update_work',
    {
      task_id: 'TASK-FE',
      kind: 'decision',
      agent_id: agent.id,
      content:
        'The browser owns the 20-second round; the API only validates and ranks final scores.',
    },
    'record a durable decision',
  );

  await beat('Building the board, timer, and score form…');
  install(['src/app/page.tsx', 'src/app/globals.css']);
  line(`${green}✓ Next.js hot reload: playable game UI installed${reset}`);

  await beat('Staying busy while Codex works — live prompts can still reach me.');
  await waitForTask('TASK-BE', (task) => task?.status === 'handoff_offered');

  await beat('Codex offered its API work. Accepting ownership with evidence…');
  await call(
    'transfer_work',
    {
      task_id: 'TASK-BE',
      action: 'accept',
      agent_id: agent.id,
      expected_version: 2,
    },
    'accept Codex handoff · v2 → v3',
  );

  await call(
    'finish_work',
    {
      task_id: 'TASK-FE',
      agent_id: agent.id,
      expected_version: 1,
      outcome: 'review_ready',
      what_changed:
        'Built a responsive 3×3 Whack-a-Mole game with timer, score form, and leaderboard.',
      changed_files: ['src/app/page.tsx', 'src/app/globals.css'],
      tests_run: ['Next.js hot reload compiled the route'],
      decisions: ['Keep round timing client-side and persist only final scores'],
      guardrails_checked: ['Keyboard-accessible buttons', 'Reduced-motion fallback'],
      needs_review_from: ['claude:reviewer'],
      provenance: [
        { field: 'changed_files', source: 'working tree' },
        { field: 'tests_run', source: 'Next.js dev server' },
      ],
    },
    'frontend review packet',
  );

  await call(
    'finish_work',
    {
      task_id: 'TASK-BE',
      agent_id: agent.id,
      expected_version: 3,
      outcome: 'review_ready',
      what_changed: 'Integrated the handed-off score validation, ranking store, and GET/POST API.',
      changed_files: ['src/lib/scores.ts', 'src/app/api/scores/route.ts'],
      tests_run: ['GET /api/scores returned 200', 'POST /api/scores returns a rank'],
      assumptions: ['The event demo uses an in-memory leaderboard'],
      guardrails_checked: ['Reject malformed JSON', 'Validate name length and integer scores'],
      needs_review_from: ['claude:reviewer'],
      provenance: [{ field: 'handoff', source: 'Codex evidence accepted through transfer_work' }],
    },
    'backend review packet',
  );

  if (promptMessageId !== undefined) {
    await call('inspect_work', { message_id: promptMessageId }, 'inspect the prompt/reply thread');
  }
  writeFileSync(join(demoDir, '.concord', 'demo-fe.done'), 'done\n');
  await beat('Frontend and accepted backend work are review-ready.');
}

async function backend() {
  await beat('Claiming the score API — including the shared game contract…');
  const started = await call(
    'start_work',
    {
      task_id: 'TASK-BE',
      title: 'Build score validation and leaderboard API',
      kind: agent.kind,
      agent_id: agent.id,
      model: 'gpt-5',
      cwd: demoDir,
      pid: process.pid,
      expected_files: ['src/app/page.tsx', 'src/lib/scores.ts', 'src/app/api/scores/route.ts'],
      modules: ['backend', 'game-state'],
      risk_tags: ['shared-game-contract'],
      notes: 'Own score validation, ranking, and the HTTP boundary.',
    },
    'claim backend + shared game state',
  );
  const overlaps = started.structuredContent?.overlaps;
  if (Array.isArray(overlaps) && overlaps.length > 0) {
    line(
      `${yellow}⚠ CONCORD CAUGHT AN OVERLAP before editing: src/app/page.tsx + game-state${reset}`,
    );
  }
  await startRelay();

  await beat('I need a boundary decision. Prompting Claude directly while it is busy…');
  await waitForPromptable('claude:frontend');
  const prompted = await call(
    'update_work',
    {
      operation: 'prompt',
      task_id: 'TASK-BE',
      agent_id: agent.id,
      to_agent_id: 'claude:frontend',
      content:
        'We both claimed game-state and page.tsx. Can you own the page while I own /api/scores, then accept my handoff?',
      idempotency_key: 'backend-boundary-question-v1',
    },
    'live prompt to busy Claude',
  );
  promptMessageId = prompted.structuredContent?.message_id;

  const replyDeadline = Date.now() + 10_000;
  while (!replyReceived && Date.now() < replyDeadline) await sleep(150);
  if (!replyReceived) throw new Error('Claude reply was not delivered to Codex');
  line(`${green}✓ reply arrived in this active Codex turn${reset}`);

  await call(
    'update_work',
    {
      task_id: 'TASK-BE',
      kind: 'decision',
      agent_id: agent.id,
      content:
        'Boundary agreed live: Claude owns page.tsx; Codex owns score validation and /api/scores.',
    },
    'persist the agreement',
  );

  await beat('Building the API without touching Claude’s page…');
  install(['src/lib/scores.ts', 'src/app/api/scores/route.ts']);
  line(`${green}✓ score validation and leaderboard routes installed${reset}`);

  await call(
    'transfer_work',
    {
      task_id: 'TASK-BE',
      action: 'offer',
      agent_id: agent.id,
      to_agent_id: 'claude:frontend',
      expected_version: 1,
      what_changed: 'Added validated in-memory score storage plus GET and POST leaderboard routes.',
      changed_files: ['src/lib/scores.ts', 'src/app/api/scores/route.ts'],
      tests_run: ['Next.js route compilation'],
      assumptions: ['Persistence is intentionally process-local for the live demo'],
      decisions: ['Do not touch page.tsx after resolving the overlap'],
      guardrails_checked: ['Malformed payloads return 400', 'Leaderboard is capped at ten results'],
      next_steps: ['Claude integrates and marks the accepted work review-ready'],
    },
    'offer evidence-bearing handoff · v1 → v2',
  );

  if (typeof promptMessageId === 'string') {
    await call('inspect_work', { message_id: promptMessageId }, 'verify durable prompt/reply');
  }
  writeFileSync(join(demoDir, '.concord', 'demo-be.done'), 'done\n');
  await beat('Handoff offered. Claude now has the full context and evidence.');
}

async function reviewer() {
  await beat('Builders are done. Starting an independent review…');
  await call(
    'start_work',
    {
      task_id: 'TASK-REVIEW',
      title: 'Review the completed Whack-a-Mole demo',
      kind: agent.kind,
      agent_id: agent.id,
      model: 'claude-sonnet',
      cwd: demoDir,
      pid: process.pid,
      expected_files: [],
      modules: ['review'],
      notes: 'Read-only review of both builder review packets and the running app.',
    },
    'claim independent review',
  );
  await inspectTask('TASK-FE');
  await inspectTask('TASK-BE');

  const port = process.env['DEMO_PORT'] ?? '3210';
  const getResponse = await fetch(`http://127.0.0.1:${port}/api/scores`);
  const postResponse = await fetch(`http://127.0.0.1:${port}/api/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reviewer', score: 7 }),
  });
  if (!getResponse.ok || postResponse.status !== 201)
    throw new Error('score API smoke test failed');
  line(`${green}✓ reviewer smoke test: GET 200 · POST 201${reset}`);

  await call(
    'update_work',
    {
      task_id: 'TASK-REVIEW',
      kind: 'finding',
      agent_id: agent.id,
      content:
        'No blocking findings: UI compiles, handoff scope matches the diff, and the score API passes GET/POST smoke tests.',
    },
    'record review finding',
  );
  await call(
    'finish_work',
    {
      task_id: 'TASK-REVIEW',
      agent_id: agent.id,
      expected_version: 1,
      outcome: 'complete',
      what_changed:
        'Reviewed both Concord packets and verified the running score API; approved with no blocking findings.',
      changed_files: [],
      tests_run: ['GET /api/scores → 200', 'POST /api/scores → 201'],
      decisions: ['Approve TASK-FE and TASK-BE for the live demo'],
      known_risks: ['Leaderboard is intentionally in-memory and resets with the demo server'],
      guardrails_checked: [
        'Reviewer made no source edits',
        'Both builder evidence packets inspected',
      ],
      provenance: [
        { field: 'review', source: 'TASK-FE and TASK-BE review packets' },
        { field: 'tests', source: 'live HTTP responses' },
      ],
    },
    'complete review with evidence',
  );
  writeFileSync(join(demoDir, '.concord', 'demo-review.done'), 'done\n');
  await beat('APPROVED — no blocking findings.');
}

try {
  line(`\n${agent.color}\u001B[1m${agent.label}${reset}`);
  line(`${dim}${'─'.repeat(46)}${reset}\n`);
  if (role === 'fe') await frontend();
  if (role === 'be') await backend();
  if (role === 'review') await reviewer();
} catch (error) {
  line(`\n\u001B[31m✗ ${error instanceof Error ? error.stack : String(error)}${reset}`);
  process.exitCode = 1;
} finally {
  if (relay !== undefined) await relay.close();
  await client.close();
}
