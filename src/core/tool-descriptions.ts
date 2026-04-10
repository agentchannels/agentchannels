/**
 * Human-readable descriptions of Claude agent tool use for status messages.
 */

export function describeToolUse(name: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  switch (name) {
    case "Read":
      return `:mag: Reading \`${shortenPath(inp.file_path)}\``;
    case "Write":
      return `:pencil: Writing \`${shortenPath(inp.file_path)}\``;
    case "Edit":
      return `:pencil2: Editing \`${shortenPath(inp.file_path)}\``;
    case "Glob":
      return `:open_file_folder: Searching files matching \`${inp.pattern || "..."}\``;
    case "Grep":
      return `:mag_right: Searching for \`${truncate(String(inp.pattern ?? ""), 40)}\``;
    case "Bash": {
      const cmd = truncate(String(inp.command ?? "").split("\n")[0], 60);
      return `:gear: Running \`${cmd}\``;
    }
    case "WebSearch":
      return `:globe_with_meridians: Searching the web for \`${truncate(String(inp.query ?? ""), 50)}\``;
    case "WebFetch":
      return `:globe_with_meridians: Fetching \`${truncate(String(inp.url ?? ""), 60)}\``;
    case "Agent":
      return `:robot_face: Spawning agent: ${truncate(String(inp.description ?? inp.prompt ?? ""), 50)}`;
    case "NotebookEdit":
      return `:notebook: Editing notebook \`${shortenPath(inp.notebook_path)}\``;
    default:
      return `:wrench: Using \`${name}\``;
  }
}

function shortenPath(path: unknown): string {
  if (typeof path !== "string") return "...";
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
