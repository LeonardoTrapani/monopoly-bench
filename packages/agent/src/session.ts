/**
 * Persisting a session's conversation between the rounds of one session (SPEC.md §6.2). Hosts
 * store `WakeResult.messages` as text and pass them back as `history` while the session key is
 * unchanged.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Schema } from "effect";

/** Every agent message is a JSON object with a `role`. */
const isMessageList = Schema.is(Schema.Array(Schema.Struct({ role: Schema.String })));

export const encodeSession = (messages: ReadonlyArray<AgentMessage>): string =>
  JSON.stringify(messages);

export const decodeSession = (text: string): ReadonlyArray<AgentMessage> => {
  // Session text is only ever written by `encodeSession` from an Agent's own (plain JSON)
  // messages; the check below rejects anything else.
  const messages: ReadonlyArray<AgentMessage> = JSON.parse(text);

  if (!isMessageList(messages)) throw new Error("Stored session is not a list of agent messages");

  return messages;
};
