import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "bun:test";

import manifest from "../package.json" with { type: "json" };

it("pins the published compose file to this relay version", () => {
  const compose = readFileSync(
    resolve(import.meta.dir, "../compose.yml"),
    "utf8",
  );
  const image =
    /image: ghcr\.io\/agentchannels\/agentchannels-relay:(\S+)/.exec(
      compose,
    )?.[1];
  expect(image).toBe(manifest.version);
});
