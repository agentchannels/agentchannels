import { internalError } from "./errors.ts";
import { readFileSync } from "node:fs";

type PackageManifest = { version?: unknown };

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw internalError("package.json does not contain a valid version.");
}

export const PRODUCT_VERSION = manifest.version;
