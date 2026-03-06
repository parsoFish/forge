/**
 * Agent runner — spawns Claude Code instances with streaming output.
 *
 * Uses stream-json output format for real-time visibility into what the agent
 * is doing (tool calls, thinking, partial results). Each agent runs in its own
 * Claude CLI session with an injected system prompt.
 *
 * Two modes:
 * - AgentRun class: event-emitting handle for async/parallel use (pool)
 * - runAgent(): blocking convenience wrapper
 *
 * Follows Ralph's pattern: fresh context per invocation. The agent reads state
 * from disk each time rather than relying on accumulated context.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import type { AgentInvocation, AgentResult } from './types.js';
import type { EventLog } from '../events/event-log.js';

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
  private agents = new Map<string, { label: string; tool: string; turns: number; startTime: number }>();
  private lineCount = 0;
  private isTTY = process.stdout.isTTY ?? false;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private completed = 0;
  private failed = 0;

  register(runId: string, label: string): void {
    this.agents.set(runId, { label, tool: 'starting...', turns: 0, startTime: Date.now() });
    if (this.isTTY && !this.renderTimer) {
      this.renderTimer = setInterval(() => this.render(), 1000);
    }
  }

  updateTool(runId: string, toolName: string): void {
    const entry = this.agents.get(runId);
    if (entry) {
      entry.tool = toolName;
      if (!this.isTTY) {
        console.log(chalk.dim(`  [${entry.label}] ${toolName}`));
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
      lines.push(chalk.dim(`    ⟳ ${entry.label}  ${entry.tool} (${elapsed}s)`));
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
  private resultPromise: Promise<AgentResult>;
  private resolveResult!: (result: AgentResult) => void;

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

    let buffer = '';
    let lastResultText = '';
    let lastCost = 0;
    let lastTurns = 0;

    this.process.stdout!.on('data', (data: Buffer) => {
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
                globalEventLog?.writeRunLog(this.runId, { type: 'text', text: block.text.slice(0, 500) });
              }
              if (block.type === 'tool_use' && block.name) {
                const toolData = {
                  tool: block.name,
                  input: JSON.stringify(block.input ?? {}).slice(0, 200),
                };
                this.emit('tool_use', toolData);
                liveTracker.updateTool(this.runId, block.name);
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
      const durationMs = Date.now() - startTime;

      if (this._cancelled) {
        const result: AgentResult = {
          success: false,
          output: 'Agent run cancelled',
          filesChanged: [],
          durationMs,
          escalate: false,
        };
        liveTracker.error(this.runId, 'Cancelled');
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
        const result: AgentResult = {
          success: false,
          output: errMsg,
          filesChanged: [],
          durationMs,
          escalate: false,
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
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
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
