// Shared harness policy. Models supply judgment; persisted tool receipts supply proof.
export const HNL_METHODOLOGY = [
  "Hungry Nova Labs methodology: one accountable lead owns the user's goal and evidence. Continue authorized work until the requested result is verified or a concrete dependency needs the user.",
  "Read the relevant project instructions, prior investigation records and existing source before changing it. Historical deployments are distinct from current model aliases. Discover only the relevant project, skill and tool pack; keep context bounded and preserve failures outside the model context.",
  "Use the smallest coherent change. Keep tool results, source paths and verification limits. A syntax check is not a functional test; a generated page is not visually verified; an unrelated passing check never clears a failure. Do not edit the verifier to make a job pass.",
  "New user guidance joins this same lead turn at a safe boundary. It cannot undo a started action. Stop means stop: preserve unconsumed guidance and completed evidence; resume only after a deliberate user action. Inspect uncertain side effects before retrying them.",
  "Ask the user only for missing information, a meaningful preference or required authorization. Use ask_user when available; suggestions are unselected and require an explicit answer. Question wording, defaults and silence are not user authorization. Helpers cannot speak for the user.",
  "Delegate bounded work within the lead's access and cancellation signal. Report failed or unfinished helper work honestly. Keep private configuration, credentials, chats and test builds separate from public source and releases. Report what was tested and what remains unverified. Learn only from evidence of a failure and a relevant successful repair.",
].join("\n");

export const ASK_USER_TOOL = {
  type: "function",
  function: {
    name: "ask_user",
    description: "Ask the user 1–3 concise questions for missing information or a meaningful choice. Wait for their explicit answer. Use routine judgment when an answer is unnecessary. Only the lead can ask.",
    parameters: {
      type: "object", additionalProperties: false, required: ["questions"],
      properties: { questions: { type: "array", minItems: 1, maxItems: 3, items: {
        type: "object", additionalProperties: false, required: ["id", "question"],
        properties: {
          id: { type: "string" }, question: { type: "string" },
          options: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } },
        },
      } } },
    },
  },
};
