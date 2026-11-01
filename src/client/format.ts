/** "Alice Example <alice@example.com>" → "Alice Example"; bare addresses are returned unchanged. */
export const displayName = (address: string): string => {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(address);
  return match?.[1]?.trim() || address.trim() || "(unknown sender)";
};

const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

/** Time for today, month and day this year, full date otherwise. */
export const formatListDate = (timestamp: number, now = new Date()): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (sameDay(date, now)) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

export const formatFullDate = (timestamp: number): string =>
  timestamp ? new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

/** 1536 → "1.5 KB". */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
