import { redactText, singleLine, truncate } from "../redact";
import type { Agent, AgentResult } from "./agent";
import type { SlackBotHandler } from "./automation";
import type { SlackBotClient } from "./client";
import { THREAD_LIMIT, toThreadMessages, type ThreadMessage } from "./thread";

export const EMPTY_QUESTION_REPLY = "Tell me what you need, for example: what Linear issues mention billing?";

// The thread is context only. A missing scope or a deleted message must not stop the bot from answering the question itself.
async function readThread(client: SlackBotClient, channel: string, threadTs: string, excludeTs: string, botUserId: () => Promise<string>): Promise<ThreadMessage[]> {
  const [raw, id] = await Promise.all([client.replies({ channel, threadTs, limit: THREAD_LIMIT }), botUserId()]);
  return toThreadMessages(raw, { botUserId: id, excludeTs });
}

export function createAgentHandler(agent: Agent): SlackBotHandler {
  const identities = new WeakMap<SlackBotClient, Promise<string>>();
  const botUserIdOf = (client: SlackBotClient) => () => {
    let cached = identities.get(client);
    if (!cached) {
      cached = client.authTest().then((i) => i.botUserId);
      cached.catch(() => identities.delete(client));
      identities.set(client, cached);
    }
    return cached;
  };

  return async ({ event, ctx, client }): Promise<AgentResult> => {
    const { channel, user, text, ts, threadTs } = event.payload;
    if (text.trim() === "") return { reply: EMPTY_QUESTION_REPLY, steps: [], status: "answered" };

    let thread: ThreadMessage[] = [];
    if (threadTs !== null) {
      try {
        thread = await readThread(client, channel, threadTs, ts, botUserIdOf(client));
      } catch (err) {
        const reason = truncate(singleLine(redactText(err instanceof Error ? err.message : String(err))), 200);
        ctx.log.warn("could not read the thread, answering without it", { channel, threadTs, reason });
      }
    }
    return agent.run({ question: text, user, thread }, { requestedBy: user, channel, threadTs: threadTs ?? ts, dryRun: ctx.dryRun === true });
  };
}
