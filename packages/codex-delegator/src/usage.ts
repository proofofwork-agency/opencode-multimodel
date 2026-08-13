import type { DelegateAccountUsage } from "./types.ts";

export function decodeAccountUsage(
  usage: unknown,
  rateLimits: unknown = null,
): DelegateAccountUsage {
  const usageObject = object(usage);
  const summary = object(usageObject?.summary) ?? usageObject ?? {};
  const buckets = Array.isArray(usageObject?.dailyUsageBuckets)
    ? usageObject.dailyUsageBuckets.flatMap((entry) => {
        const bucket = object(entry);
        const startDate = text(bucket?.startDate);
        const tokens = number(bucket?.tokens);
        return startDate && tokens !== null ? [{ startDate, tokens }] : [];
      })
    : [];
  const limits =
    object(object(rateLimits)?.rateLimits) ?? object(rateLimits) ?? {};
  const primary = object(limits.primary);
  const secondary = object(limits.secondary);
  return {
    lifetimeTokens: number(summary.lifetimeTokens, summary.lifetime_tokens),
    peakDailyTokens: number(summary.peakDailyTokens, summary.peak_daily_tokens),
    longestRunningTurnSec: number(
      summary.longestRunningTurnSec,
      summary.longest_running_turn_sec,
    ),
    currentStreakDays: number(
      summary.currentStreakDays,
      summary.current_streak_days,
    ),
    longestStreakDays: number(
      summary.longestStreakDays,
      summary.longest_streak_days,
    ),
    dailyUsageBuckets: buckets,
    primaryUsedPercent: number(primary?.usedPercent, primary?.used_percent),
    primaryResetsAt: number(primary?.resetsAt, primary?.resets_at),
    secondaryUsedPercent: number(
      secondary?.usedPercent,
      secondary?.used_percent,
    ),
    secondaryResetsAt: number(secondary?.resetsAt, secondary?.resets_at),
  };
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function number(...values: unknown[]) {
  return (
    values.find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ) ?? null
  );
}
