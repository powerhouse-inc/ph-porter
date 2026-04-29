import type { AgentProvider, StreamChunk } from '@powerhousedao/ph-clint';

/**
 * Demo agent — deterministic echo responses without an API key.
 *
 * Echoes user prompts with conversation tracking per thread.
 */
export function createDemoAgent(): AgentProvider {
  const conversations = new Map<string, string[]>();

  return {
    id: 'ph-porter-agent',
    async *stream(prompt, opts) {
      const threadId = opts?.threadId ?? 'default';
      if (!conversations.has(threadId)) {
        conversations.set(threadId, []);
      }
      const history = conversations.get(threadId)!;
      history.push(prompt);

      const turnCount = history.length;
      if (turnCount > 1) {
        yield {
          type: 'text-delta',
          text: `I understand you're continuing our conversation (turn ${turnCount}). `,
        } satisfies StreamChunk;
      }
      yield {
        type: 'text-delta',
        text: `You said: "${prompt}". I'm the demo agent — set an API key for real LLM responses.`,
      } satisfies StreamChunk;
    },
  };
}
