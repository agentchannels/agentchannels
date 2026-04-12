/**
 * Human-readable descriptions of Claude agent tool use for status messages.
 */

export function describeToolUse(name: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // Normalize tool name for matching (handles both PascalCase and snake_case)
  const n = name.toLowerCase();

  switch (n) {
    case "read":
    case "file_read":
      return `:mag: Reading \`${shortenPath(inp.file_path ?? inp.path)}\``;
    case "write":
    case "file_write":
      return `:pencil: Writing \`${shortenPath(inp.file_path ?? inp.path)}\``;
    case "edit":
    case "file_edit":
      return `:pencil2: Editing \`${shortenPath(inp.file_path ?? inp.path)}\``;
    case "glob":
      return `:open_file_folder: Searching files matching \`${inp.pattern || "..."}\``;
    case "grep":
      return `:mag_right: Searching for \`${truncate(String(inp.pattern ?? ""), 40)}\``;
    case "bash":
    case "execute_bash": {
      const cmd = truncate(String(inp.command ?? "").split("\n")[0], 60);
      return `:gear: Running \`${cmd}\``;
    }
    case "websearch":
    case "web_search":
      return `:globe_with_meridians: Searching the web for \`${truncate(String(inp.query ?? ""), 50)}\``;
    case "webfetch":
    case "web_fetch":
      return `:globe_with_meridians: Fetching \`${truncate(String(inp.url ?? ""), 60)}\``;
    case "agent":
      return `:robot_face: Spawning agent: ${truncate(String(inp.description ?? inp.prompt ?? ""), 50)}`;
    case "notebookedit":
      return `:notebook: Editing notebook \`${shortenPath(inp.notebook_path)}\``;
    case "list_directory":
      return `:open_file_folder: Listing \`${shortenPath(inp.path)}\``;
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
