// Default to confirmations on; only a stored boolean false disables them.
export function confirmationsEnabled(stored) {
  return stored !== false;
}

// The setting is captured at the beginning of a request, so toggling it while
// the agent is running cannot unexpectedly relax that request's safety policy.
export function approvalForRequest(enabled, askApproval, signal) {
  return async details => {
    if (signal?.aborted) return false;
    if (!confirmationsEnabled(enabled)) return true;
    return Boolean(await askApproval(details, signal)) && !signal?.aborted;
  };
}
