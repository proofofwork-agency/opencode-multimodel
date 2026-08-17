const GOAL_SLASH = /^\/goal(?:\s+([\s\S]*))?$/i;

export function goalSlashArguments(text: string): string | undefined {
  const match = text.trim().match(GOAL_SLASH);
  if (!match) return;
  return match[1]?.trim() ?? "";
}

export function sessionLooksBusy(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const type = "type" in status ? status.type : undefined;
  return type === "busy" || type === "retry";
}

export function shouldStartGoalTurn(action: string): boolean {
  return action === "set" || action === "add" || action === "resume" ||
    action === "edit" || action === "focus" || action === "sequence";
}

export function shouldSteerLiveTurn(action: string, busy: boolean): boolean {
  return busy && shouldStartGoalTurn(action);
}
