import type { Logger } from "#types";

// Logs carry IDs and error codes only, never message text.
export const log: Logger = (level, message, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
};
