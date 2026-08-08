const SAFETY_BOUNDARY =
  "Do not commit, push, merge, deploy, publish, send externally, change credentials, delete data, or mutate production. Stop and report if any of those actions are required.";

export function buildAskCodexTask(request: string): string {
  return `Complete the following bounded task and verify the result with the most relevant tests or inspection.\n\nUser request:\n${request.trim()}\n\n${SAFETY_BOUNDARY}`;
}

export function buildCodexReviewTask(focus?: string): string {
  const focusText = focus?.trim() ? `\nReview focus:\n${focus.trim()}\n` : "";
  return `Review only. Do not edit files or change repository state.${focusText}
Inspect the current repository and report only substantive findings. Prioritise correctness, security, regressions, data loss, concurrency and missing tests. Include file and line references plus a concrete recommendation for every finding. If no substantive issue is found, say so directly.

${SAFETY_BOUNDARY}`;
}
