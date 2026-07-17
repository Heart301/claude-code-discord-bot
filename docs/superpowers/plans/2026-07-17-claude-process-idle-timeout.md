# Claude Process Idle Timeout + Absolute Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single fixed 20-minute timeout on the spawned `claude` process with an idle timeout (resets on any stdout output) plus an independent absolute runtime cap, so long-running-but-active sessions aren't killed while truly stuck or runaway sessions still get cut off.

**Architecture:** Two `setTimeout` timers live inside `ClaudeManager.runClaudeCode` (`src/claude/manager.ts`): `idleTimer` (15 min, reset on every `stdout` `data` event) and `absoluteTimer` (60 min, set once, never reset). A shared `triggerTimeout(kind)` helper kills the process, clears both timers, and sends a Discord embed whose text depends on `kind`. Both timers are also cleared wherever the existing code already clears the old single `timeout` (on `result`, `close`, `error`).

**Tech Stack:** TypeScript (Bun runtime), Vitest (`vi.useFakeTimers`), discord.js `EmbedBuilder`.

## Global Constraints

- Idle timeout: 15 minutes (`15 * 60 * 1000` ms) with no stdout output.
- Absolute timeout: 60 minutes (`60 * 60 * 1000` ms) total runtime regardless of output.
- Idle timeout resets on **any** stdout `data` event, including partial/non-JSON chunks — not just fully-parsed JSON lines.
- Idle-timeout embed: title `⏰ 逾時`, description `Claude Code 已 15 分鐘沒有任何回應`.
- Absolute-timeout embed: title `⏰ 逾時`, description `Claude Code 執行時間已超過 60 分鐘上限`.
- Both embeds keep the existing color `0xFFD700`.
- Both timers must be cleared when the session ends normally (`result` message) or the process exits/errors (`close`/`error` handlers), so no stray timer fires after the process is already gone.
- Run tests with `bun run test:run` (never plain `bun test` — see `CLAUDE.md`).

---

### Task 1: Idle timeout + absolute timeout in `runClaudeCode`

**Files:**
- Modify: `src/claude/manager.ts:1-9` (module-level timeout constants), `src/claude/manager.ts:155-171` (timer setup), `src/claude/manager.ts:173` (stdout data handler start), `src/claude/manager.ts:203-207` (result cleanup), `src/claude/manager.ts:225-227` (close handler), `src/claude/manager.ts:267-269` (error handler)
- Test: `test/claude/manager.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: existing `ClaudeManager.runClaudeCode(channelId, channelName, prompt, sessionId?, discordContext?)` signature (unchanged), existing `mockProcess` shape used throughout `test/claude/manager.test.ts` (`{ pid, stdin: { end }, stdout: { on }, stderr: { on }, on, kill }`), existing `EmbedBuilder` usage conventions.
- Produces: no new public API — this task only changes internal timer behavior inside `runClaudeCode`. No other task depends on this one.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `test/claude/manager.test.ts`, right after the closing `});` of the existing `describe('duplicate final message cleanup', ...)` block (currently ending at line 404) and before `describe('database integration', ...)`:

```ts
  describe('idle timeout and absolute timeout', () => {
    let mockChannel: any;
    let mockProcess: any;

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.mocked(fs.existsSync).mockReturnValue(true);

      mockChannel = { send: vi.fn().mockResolvedValue({}) };
      manager.setDiscordMessage('channel-1', { channel: mockChannel });

      mockProcess = {
        pid: 1,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});
      await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function getStdoutDataHandler() {
      const call = mockProcess.stdout.on.mock.calls.find((c: any[]) => c[0] === 'data');
      return call?.[1];
    }

    it('kills the process after 15 minutes with no stdout output', () => {
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const embed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toBe('Claude Code 已 15 分鐘沒有任何回應');
    });

    it('resets the idle timer on any stdout output, even a partial non-JSON chunk', () => {
      const dataHandler = getStdoutDataHandler();
      expect(dataHandler).toBeDefined();

      // Just under the original idle deadline, some output arrives (not a full JSON line).
      vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000);
      dataHandler(Buffer.from('partial output, not a full line yet'));

      // The original 15-minute-from-start deadline passes with no kill,
      // because the data above reset the timer.
      vi.advanceTimersByTime(2000);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // A further 15 minutes from the reset point with still no output
      // triggers the idle timeout.
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('triggers the absolute timeout instead of idle timeout when output keeps arriving but total runtime exceeds 60 minutes', () => {
      const dataHandler = getStdoutDataHandler();

      // Emit a small chunk every 10 minutes, well under the 15-minute idle
      // deadline, for just under an hour.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(10 * 60 * 1000);
        dataHandler(Buffer.from('keep-alive chunk'));
      }
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Crossing the 60-minute absolute cap kills the process even though
      // output kept arriving.
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      const embed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toBe('Claude Code 執行時間已超過 60 分鐘上限');
    });

    it('clears both timers once the result message is handled, so no timeout fires afterward', async () => {
      const dataHandler = getStdoutDataHandler();

      const resultLine = JSON.stringify({
        type: 'result',
        session_id: 'session-1',
        subtype: 'success',
        result: 'done',
        num_turns: 1,
      });
      dataHandler(Buffer.from(`${resultLine}\n`));

      // Flush the microtask/macrotask queue so the queued handleResultMessage
      // and its cleanup .then() settle (same pattern as the existing
      // "duplicate final message cleanup" tests — setImmediate is real here
      // because fake timers only fake setTimeout/clearTimeout).
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockProcess.kill).toHaveBeenCalledTimes(1);

      mockChannel.send.mockClear();
      vi.advanceTimersByTime(60 * 60 * 1000);

      expect(mockProcess.kill).toHaveBeenCalledTimes(1);
      expect(mockChannel.send).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:run`
Expected: The 4 new tests in `describe('idle timeout and absolute timeout', ...)` FAIL (the process still uses a single fixed 20-minute timeout that never resets and never distinguishes idle vs. absolute). Every other existing test in the file still passes.

- [ ] **Step 3: Implement idle timeout + absolute timeout**

In `src/claude/manager.ts`, add these two module-level constants right after the existing imports (currently ending at line 7 with `import { DatabaseManager } from "../db/database.js";`), before `export class ClaudeManager {`:

```ts
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes with no stdout output
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes total runtime, regardless of output
```

Then replace lines 155-171 (now shifted down by 3 lines from the constants above, but locate by content):

```ts
    let buffer = "";

    // Set a timeout for the Claude process (20 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ 逾時")
          .setDescription("Claude Code 回應時間過長（超過 20 分鐘）")
          .setColor(0xFFD700); // Yellow for timeout

        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 20 * 60 * 1000); // 20 minutes
```

with:

```ts
    let buffer = "";

    let idleTimer: ReturnType<typeof setTimeout>;
    let absoluteTimer: ReturnType<typeof setTimeout>;

    const triggerTimeout = (kind: "idle" | "absolute") => {
      console.log(`Claude process timed out (${kind}), killing it`);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ 逾時")
          .setDescription(
            kind === "idle"
              ? "Claude Code 已 15 分鐘沒有任何回應"
              : "Claude Code 執行時間已超過 60 分鐘上限"
          )
          .setColor(0xFFD700); // Yellow for timeout

        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();
    absoluteTimer = setTimeout(() => triggerTimeout("absolute"), ABSOLUTE_TIMEOUT_MS);
```

Then update the stdout data handler start (currently `src/claude/manager.ts:173`):

```ts
    claude.stdout.on("data", (data) => {
      const rawData = data.toString();
```

to:

```ts
    claude.stdout.on("data", (data) => {
      resetIdleTimer();
      const rawData = data.toString();
```

Then update the result-message cleanup (currently `src/claude/manager.ts:203-207`):

```ts
              ).then(() => {
                clearTimeout(timeout);
                claude.kill("SIGTERM");
                this.channelProcesses.delete(channelId);
              });
```

to:

```ts
              ).then(() => {
                clearTimeout(idleTimer);
                clearTimeout(absoluteTimer);
                claude.kill("SIGTERM");
                this.channelProcesses.delete(channelId);
              });
```

Then update the `close` handler (currently `src/claude/manager.ts:225-227`):

```ts
    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);
```

to:

```ts
    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
```

Then update the `error` handler (currently `src/claude/manager.ts:267-269`):

```ts
    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);
```

to:

```ts
    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:run`
Expected: All tests in `test/claude/manager.test.ts` PASS, including the 4 new ones. Note: this repo currently has 7 pre-existing unrelated failures in `test/utils/shell.test.ts` caused by a leaked `CLAUDE_PERMISSION_MODE` env var in the local shell session — confirm those are unchanged in count/cause, not newly introduced by this change.

- [ ] **Step 5: Commit**

```bash
git add src/claude/manager.ts test/claude/manager.test.ts
git commit -m "$(cat <<'EOF'
feat: replace fixed 20-minute timeout with idle timeout + absolute cap

Any stdout output now resets a 15-minute idle timer so active sessions
aren't killed mid-task; a separate 60-minute absolute cap still bounds
truly stuck or runaway sessions.
EOF
)"
```
