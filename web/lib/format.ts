// Small display formatters, kept pure so they can be unit-tested.

/** A USD cost for the header: nothing for free, "<$0.01" for fractions of a cent. */
export const formatCost = (usd: number): string => {
  if (usd <= 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
};

const trimDecimal = (value: number): string => {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
};

/** Token counts: exact under a thousand, then "12.3k" / "1.2M" with one trimmed decimal. */
export const formatTokens = (n: number): string => {
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    return `${trimDecimal(n / 1000)}k`;
  }
  return `${trimDecimal(n / 1_000_000)}M`;
};

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});

/** "just now", "3m ago", "2h ago", "4d ago", then a short date beyond a week. `then` and `now` are epoch ms. */
export const relativeTime = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  // 45–59s rounds up to "1m ago" rather than showing "0m".
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days <= 7) {
    return `${days}d ago`;
  }
  return dateFormat.format(new Date(then));
};
