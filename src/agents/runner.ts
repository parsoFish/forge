/**
 * Agent runner — spawns Claude Code instances with streaming output.
 *
 * Uses stream-json output format for real-time visibility into what the agent
 * is doing (tool calls, thinking, partial results). Each agent runs in its own
 * Claude CLI session with an injected system prompt.
 *
 * Two modes:
 * - AgentRun class: event-emitting handle for async/parallel use
 * - runAgent(): blocking convenience wrapper
 *
 * Follows Ralph's pattern: fresh context per invocation. The agent reads state
 * from disk each time rather than relying on accumulated context.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFileSync as writeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import chalk from 'chalk';
import type { AgentInvocation, AgentResult } from './types.js';
import type { EventLog } from '../events/event-log.js';

/** Default wall-clock timeout per agent run (15 minutes). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * When true, the LiveTracker acts as if stdout is not a TTY — no cursor
 * manipulation, no in-place overwrites. This prevents ANSI escape codes
 * from fighting with the readline prompt in interactive session mode.
 */
let _sessionMode = false;

/**
 * Enable/disable session mode. When enabled, LiveTracker disables all
 * ANSI cursor manipulation and falls back to simple per-line output.
 * Called by Session.start() before launching any agents.
 */
export function setSessionMode(enabled: boolean): void {
  _sessionMode = enabled;
}

/**
 * Max time a single subprocess (bash command) can be idle before being killed.
 * "Idle" = the process tree hasn't changed and no stdout has been produced.
 * This catches hung grep/curl/etc. without killing legitimately long builds.
 */
const SUBPROCESS_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Compact live-status tracker for concurrent agent runs.
 *
 * WHY: When multiple agents run in parallel, per-tool-use console.log lines
 * create wall-of-text noise. Instead, we maintain a single status line per
 * active agent that overwrites in place — like a progress bar.
 *
 * Falls back to simple per-line output when stdout is not a TTY.
 */
class LiveTracker {
  private agents = new Map<string, { label: string; tool: string; detail: string; turns: number; startTime: number }>();
  private lineCount = 0;

  /** Dynamic TTY check — returns false in session mode to avoid cursor conflicts. */
  private get isTTY(): boolean {
    return !_sessionMode && (process.stdout.isTTY ?? false);
  }
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private completed = 0;
  private failed = 0;

  register(runId: string, label: string): void {
    this.agents.set(runId, { label, tool: 'starting...', detail: '', turns: 0, startTime: Date.now() });
    if (this.isTTY && !this.renderTimer) {
      this.renderTimer = setInterval(() => this.render(), 1000);
    }
  }

  updateTool(runId: string, toolName: string, detail = ''): void {
    const entry = this.agents.get(runId);
    if (entry) {
      entry.tool = toolName;
      entry.detail = detail;
      if (!this.isTTY) {
        const desc = detail ? `${toolName} ${detail}` : toolName;
        console.log(chalk.dim(`  [${entry.label}] ${desc}`));
      }
    }
  }

  updateTurns(runId: string, turns: number): void {
    const entry = this.agents.get(runId);
    if (entry) entry.turns = turns;
  }

  complete(runId: string, cost: number, turns: number, durationMs: number): void {
    const entry = this.agents.get(runId);
    const label = entry?.label ?? 'agent';
    this.agents.delete(runId);
    this.completed++;

    if (this.isTTY) this.clearLines();
    console.log(chalk.green(`  ✓ ${label}  $${cost.toFixed(4)} | ${turns} turns | ${(durationMs / 1000).toFixed(0)}s`));
    this.lineCount = 0;

    if (this.agents.size > 0) this.render();
    else this.stopTimer();
  }

  error(runId: string, msg: string): void {
    const entry = this.agents.get(runId);
    const label = entry?.label ?? 'agent';
    this.agents.delete(runId);
    this.failed++;

    if (this.isTTY) this.clearLines();
    console.log(chalk.red(`  ✗ ${label}  ${msg}`));
    this.lineCount = 0;

    if (this.agents.size > 0) this.render();
    else this.stopTimer();
  }

  private render(): void {
    if (!this.isTTY || this.agents.size === 0) return;
    this.clearLines();

    const lines: string[] = [];
    // Status summary line
    const stats = [];
    if (this.completed > 0) stats.push(`${this.completed} done`);
    if (this.failed > 0) stats.push(`${this.failed} failed`);
    stats.push(`${this.agents.size} active`);
    lines.push(chalk.dim(`  [${stats.join(' | ')}]`));

    for (const [, entry] of this.agents) {
      const elapsed = ((Date.now() - entry.startTime) / 1000).toFixed(0);
      const desc = entry.detail ? `${entry.tool} ${chalk.dim(entry.detail)}` : entry.tool;
      lines.push(chalk.dim(`    ⟳ ${entry.label}  ${desc} (${elapsed}s)`));
    }

    process.stdout.write(lines.join('\n') + '\n');
    this.lineCount = lines.length;
  }

  private clearLines(): void {
    if (this.lineCount > 0) {
      process.stdout.write(`\x1b[${this.lineCount}A\x1b[0J`);
      this.lineCount = 0;
    }
  }

  private stopTimer(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }
}

/**
 * Extract a short human-readable detail from a tool invocation's input.
 * Keeps it cheap — just reads known keys, no summarisation.
 */
function extractToolDetail(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return shortPath(input.file_path as string | undefined);
    case 'Glob':
      return (input.pattern as string | undefined) ?? '';
    case 'Grep':
      return (input.pattern as string | undefined)?.slice(0, 40) ?? '';
    case 'Bash': {
      const cmd = (input.command as string | undefined) ?? '';
      // First meaningful token(s) — e.g. "npm run test" or "git push"
      return cmd.slice(0, 60).split('\n')[0] ?? '';
    }
    case 'Agent':
      return (input.description as string | undefined) ?? '';
    default:
      return '';
  }
}

function shortPath(p?: string): string {
  if (!p) return '';
  // Show last 2 path segments for context
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

/** Singleton live tracker shared by all agent runs. */
const liveTracker = new LiveTracker();

/**
 * Global event log reference. Set by the orchestrator at startup so all
 * agent runs automatically emit events without needing to pass the log
 * through every function signature.
 */
let globalEventLog: EventLog | null = null;

/**
 * Set the global event log for all agent runs.
 * Called once by the orchestrator during initialization.
 */
export function setGlobalEventLog(log: EventLog): void {
  globalEventLog = log;
}

/**
 * A chunk from Claude's stream-json output format.
 * Types include: assistant, tool_use, tool_result, result, system
 */
/**
 * Parse a rate-limit reset time from Claude CLI error output.
 * Returns the reset timestamp (ms since epoch) or null if not a rate limit error.
 *
 * Claude CLI may output messages like:
 *   "Rate limit exceeded. Retry after 2026-03-07T02:15:00Z"
 *   "Too many requests. Please retry after 60 seconds"
 *   "rate_limit_error ... retry after ... seconds"
 */
export function parseRateLimitReset(errorText: string): number | null {
  // Match Claude CLI's usage limit messages and standard API rate limit errors
  if (!/rate.?limit|too many requests|429|overloaded|hit your limit|usage limit/i.test(errorText)) return null;

  // Try ISO timestamp: "retry after 2026-03-07T02:15:00Z"
  const isoMatch = errorText.match(/retry\s+after\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (isoMatch) {
    const ts = new Date(isoMatch[1]).getTime();
    if (!isNaN(ts)) return ts;
  }

  // Try seconds: "retry after 60 seconds" or "retry in 60s"
  const secMatch = errorText.match(/retry\s+(?:after|in)\s+(\d+)\s*s(?:ec(?:ond)?s?)?/i);
  if (secMatch) {
    return Date.now() + parseInt(secMatch[1], 10) * 1000;
  }

  // Claude CLI subscription limit: "resets 3am (Australia/Brisbane)"
  // Parse the hour and compute next occurrence of that local time.
  const resetMatch = errorText.match(/resets\s+(\d{1,2})(am|pm)/i);
  if (resetMatch) {
    let hour = parseInt(resetMatch[1], 10);
    const isPM = resetMatch[2].toLowerCase() === 'pm';
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;

    const now = new Date();
    const resetToday = new Date(now);
    resetToday.setHours(hour, 0, 0, 0);

    // If the reset time is in the past today, it means tomorrow
    const resetTime = resetToday.getTime() > now.getTime()
      ? resetToday.getTime()
      : resetToday.getTime() + 24 * 60 * 60 * 1000;

    return resetTime;
  }

  // Generic rate limit with no parseable reset — default 5 min backoff
  return Date.now() + 5 * 60_000;
}

export interface StreamChunk {
  type: string;
  subtype?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  // result chunk (final)
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
}

/**
 * Handle for a running agent — allows monitoring and cancellation.
 *
 * Emits events as the agent works:
 * - 'chunk': raw stream-json chunk
 * - 'tool_use': agent invoked a tool
 * - 'text': agent produced text output
 * - 'cost': cost/duration update (from result chunk)
 * - 'done': agent finished (success or failure)
 * - 'error': agent errored
 */
export class AgentRun extends EventEmitter {
  readonly runId: string;
  readonly agentRole: string;
  private process: ChildProcess | null = null;
  private _completed = false;
  private _cancelled = false;
  private _timedOut = false;
  private resultPromise: Promise<AgentResult>;
  private resolveResult!: (result: AgentResult) => void;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks the last time we saw meaningful activity (stdout data). */
  private lastActivityAt = Date.now();

  constructor(
    readonly invocation: AgentInvocation,
  ) {
    super();
    this.runId = randomUUID().slice(0, 12);
    this.agentRole = invocation.agent.role;

    this.resultPromise = new Promise<AgentResult>((resolve) => {
      this.resolveResult = resolve;
    });

    // Prevent unhandled 'error' events from crashing Node.
    // Callers should attach their own error handler; this is the safety net.
    this.on('error', () => {});
  }

  /** Whether this run has finished (success or failure). */
  get completed(): boolean { return this._completed; }

  /** Whether this run was cancelled. */
  get cancelled(): boolean { return this._cancelled; }

  /**
   * Start the agent subprocess.
   */
  start(): void {
    const { agent, prompt, cwd, maxTurns, context } = this.invocation;
    const startTime = Date.now();

    const fullPrompt = context
      ? `${prompt}\n\n## Additional Context\n\n${context}`
      : prompt;

    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--model', agent.model,
      '--max-turns', String(maxTurns),
      '--append-system-prompt', agent.systemPrompt,
    ];

    this.process = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Place process in cgroup for memory isolation (if provided by worker)
    if (this.invocation.cgroupPath && this.process.pid) {
      try {
        writeFs(
          joinPath(this.invocation.cgroupPath, 'cgroup.procs'),
          String(this.process.pid),
        );
      } catch {
        // Cgroup placement failed — non-fatal, process runs without limits
      }
    }

    // Log spawn to global event log
    globalEventLog?.emit({
      type: 'agent.spawn',
      agentRole: this.agentRole,
      runId: this.runId,
      summary: `Spawned ${this.agentRole} [${this.runId}] in ${cwd}`,
    });
    globalEventLog?.openRunLog(this.runId, {
      project: (cwd ?? '').split('/').pop(),
      agentRole: this.agentRole,
    });

    // Register with the live tracker — label includes project for context
    const project = (cwd ?? '').split('/').pop() ?? '';
    const label = project ? `${this.agentRole}/${project}` : this.agentRole;
    liveTracker.register(this.runId, label);

    // Wall-clock timeout — auto-cancel if the agent runs too long
    const timeoutMs = (maxTurns > 30) ? DEFAULT_TIMEOUT_MS * 2 : DEFAULT_TIMEOUT_MS;
    this.timeoutTimer = setTimeout(() => {
      if (this._completed || this._cancelled) return;
      this._timedOut = true;
      console.log(chalk.red(`  ⏰ ${label}: wall-clock timeout (${(timeoutMs / 60_000).toFixed(0)}min) — killing agent`));
      globalEventLog?.emit({
        type: 'agent.error',
        agentRole: this.agentRole,
        runId: this.runId,
        summary: `Timeout: ${this.agentRole} killed after ${(timeoutMs / 60_000).toFixed(0)}min`,
      });
      this.cancel();
    }, timeoutMs);

    // Subprocess watchdog — detect hung child processes (e.g. grep waiting on stdin)
    this.lastActivityAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (this._completed || this._cancelled) return;
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs < SUBPROCESS_IDLE_TIMEOUT_MS) return;

      // Check if there are grandchild processes that might be stuck
      const pid = this.process?.pid;
      if (!pid) return;
      try {
        // Find leaf processes in the agent's tree (the actual commands, not claude threads)
        const tree = execSync(
          `ps --ppid $(ps --ppid ${pid} -o pid= 2>/dev/null | tr '\\n' ',')0 -o pid=,etime=,args= 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (!tree) return;

        // Parse and kill any leaf process running longer than the idle timeout
        for (const line of tree.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)/);
          if (!match) continue;
          const [, childPid, , cmd] = match;
          // Only kill likely-stuck commands (grep, curl, etc.), not claude threads
          if (/grep|curl|wget|cat|read|sleep|nc\b/.test(cmd)) {
            console.log(chalk.yellow(`  🔪 ${label}: killing stuck subprocess ${childPid}: ${cmd.slice(0, 60)}`));
            try { process.kill(parseInt(childPid, 10), 'SIGTERM'); } catch { /* already dead */ }
            this.lastActivityAt = Date.now(); // Reset so we don't immediately re-trigger
          }
        }
      } catch { /* ps failed — not critical */ }
    }, 30_000); // Check every 30s

    let buffer = '';
    let lastResultText = '';
    let lastCost = 0;
    let lastTurns = 0;

    this.process.stdout!.on('data', (data: Buffer) => {
      this.lastActivityAt = Date.now(); // Any stdout = activity
      buffer += data.toString();

      // stream-json emits newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as StreamChunk;
          this.emit('chunk', chunk);

          // Extract useful info from assistant message chunks
          if (chunk.type === 'assistant' && chunk.message?.content) {
            for (const block of chunk.message.content) {
              if (block.type === 'text' && block.text) {
                this.emit('text', { text: block.text });
                // Per-run log only — NOT global events (async stream, low overhead)
                globalEventLog?.writeRunLog(this.runId, { type: 'text', text: block.text });
              }
              if (block.type === 'tool_use' && block.name) {
                const toolData = {
                  tool: block.name,
                  input: JSON.stringify(block.input ?? {}).slice(0, 200),
                };
                this.emit('tool_use', toolData);
                const detail = extractToolDetail(block.name, block.input);
                liveTracker.updateTool(this.runId, block.name, detail);
                // Tool use events go to both global (for actions pane) and per-run log.
                // Safe now that global events are buffered (500ms batch flush).
                globalEventLog?.emit({
                  type: 'agent.tool_use',
                  agentRole: this.agentRole,
                  runId: this.runId,
                  summary: `${this.agentRole}: ${block.name}`,
                  data: toolData as unknown as Record<string, unknown>,
                });
                globalEventLog?.writeRunLog(this.runId, { type: 'tool_use', ...toolData });
              }
            }
          }

          // Final result chunk
          if (chunk.type === 'result') {
            lastResultText = chunk.result ?? '';
            lastCost = chunk.total_cost_usd ?? 0;
            lastTurns = chunk.num_turns ?? 0;

            const costData = {
              totalCostUsd: lastCost,
              durationMs: chunk.duration_ms ?? (Date.now() - startTime),
              numTurns: lastTurns,
            };
            this.emit('cost', costData);
            liveTracker.updateTurns(this.runId, lastTurns);
            globalEventLog?.emit({
              type: 'agent.cost',
              agentRole: this.agentRole,
              runId: this.runId,
              summary: `${this.agentRole}: $${lastCost.toFixed(4)} / ${lastTurns} turns / ${((costData.durationMs) / 1000).toFixed(1)}s`,
              data: costData as unknown as Record<string, unknown>,
            });
          }
        } catch {
          // Partial/malformed JSON — skip
        }
      }
    });

    let stderr = '';
    this.process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    this.process.on('close', (code) => {
      this._completed = true;
      this.clearTimers();
      const durationMs = Date.now() - startTime;

      if (this._cancelled) {
        const result: AgentResult = {
          success: false,
          output: this._timedOut
            ? `Agent timed out after ${(durationMs / 60_000).toFixed(0)} minutes`
            : 'Agent run cancelled',
          filesChanged: [],
          durationMs,
          escalate: false,
        };
        liveTracker.error(this.runId, this._timedOut ? `Timeout (${(durationMs / 60_000).toFixed(0)}min)` : 'Cancelled');
        globalEventLog?.emit({
          type: 'agent.result',
          agentRole: this.agentRole,
          runId: this.runId,
          summary: `Cancelled: ${this.agentRole} [${this.runId}]`,
        });
        globalEventLog?.closeRunLog(this.runId);
        this.emit('done', result);
        this.resolveResult(result);
        return;
      }

      if (code === 0) {
        const escalate = lastResultText.includes('ESCALATE:');
        const escalateReason = escalate
          ? lastResultText.match(/ESCALATE:\s*(.+)/)?.[1]?.trim()
          : undefined;

        const result: AgentResult = {
          success: !lastResultText.includes('FAILED:'),
          output: lastResultText,
          filesChanged: [],
          durationMs,
          escalate,
          escalateReason,
        };
        globalEventLog?.emit({
          type: 'agent.result',
          agentRole: this.agentRole,
          runId: this.runId,
          summary: `Completed: ${this.agentRole} ($${lastCost.toFixed(4)}, ${lastTurns} turns, ${(durationMs / 1000).toFixed(1)}s)`,
        });
        liveTracker.complete(this.runId, lastCost, lastTurns, durationMs);
        globalEventLog?.writeRunLog(this.runId, {
          type: 'result', success: result.success, outputLength: result.output.length, durationMs,
        });
        globalEventLog?.closeRunLog(this.runId);
        this.emit('done', result);
        this.resolveResult(result);
      } else {
        const errMsg = stderr || lastResultText || `Exit code ${code}`;
        const rateLimitResetAt = parseRateLimitReset(errMsg) ?? undefined;
        const result: AgentResult = {
          success: false,
          output: errMsg,
          filesChanged: [],
          durationMs,
          escalate: false,
          rateLimitResetAt,
        };
        globalEventLog?.emit({
          type: 'agent.error',
          agentRole: this.agentRole,
          runId: this.runId,
          summary: `Error: ${this.agentRole} exit ${code}: ${errMsg.slice(0, 200)}`,
        });
        liveTracker.error(this.runId, errMsg.slice(0, 100));
        globalEventLog?.closeRunLog(this.runId);
        this.emit('error', new Error(`Claude exited with code ${code}: ${errMsg}`));
        this.emit('done', result);
        this.resolveResult(result);
      }
    });

    this.process.on('error', (err) => {
      this._completed = true;
      this.clearTimers();
      const result: AgentResult = {
        success: false,
        output: `Failed to spawn Claude: ${err.message}`,
        filesChanged: [],
        durationMs: Date.now() - startTime,
        escalate: false,
      };
      liveTracker.error(this.runId, `Spawn failed: ${err.message.slice(0, 80)}`);
      this.emit('error', err);
      this.emit('done', result);
      this.resolveResult(result);
    });

    // Pipe prompt via stdin and close to signal EOF
    this.process.stdin!.write(fullPrompt);
    this.process.stdin!.end();
  }

  /**
   * Wait for this run to complete and return the result.
   */
  async wait(): Promise<AgentResult> {
    return this.resultPromise;
  }

  /**
   * Cancel this run by killing the subprocess.
   */
  cancel(): void {
    if (this._completed || this._cancelled) return;
    this._cancelled = true;
    this.clearTimers();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
  }

  /** Clean up timeout and watchdog timers. */
  private clearTimers(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

/**
 * Convenience: run an agent and wait for the result (blocking).
 * For the parallel pool, use AgentRun directly.
 */
export async function runAgent(invocation: AgentInvocation): Promise<AgentResult> {
  const run = new AgentRun(invocation);
  run.start();
  return run.wait();
}
