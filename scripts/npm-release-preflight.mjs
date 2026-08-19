import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
const releasePrerelease = process.env.RELEASE_PRERELEASE === "true";
const releaseBody = process.env.RELEASE_BODY ?? "";
if (repository !== "agentchannels/agentchannels") {
  throw new Error("npm publication requires agentchannels/agentchannels");
}
if (!existsSync("LICENSE")) throw new Error("npm publication requires LICENSE");
if (typeof manifest.license !== "string" || manifest.license.length === 0) {
  throw new Error("package.json requires license metadata");
}
const repositoryUrl =
  typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository?.url;
if (
  repositoryUrl !== "https://github.com/agentchannels/agentchannels.git" &&
  repositoryUrl !== "git+https://github.com/agentchannels/agentchannels.git"
) {
  throw new Error(
    "package.json repository must target the official repository",
  );
}
if (typeof manifest.version !== "string") {
  throw new Error("package.json version is missing");
}
if (tag !== `v${manifest.version}`) {
  throw new Error(`release tag must equal v${manifest.version}`);
}
const exactTag = execFileSync(
  "git",
  ["describe", "--tags", "--exact-match", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
if (exactTag !== tag)
  throw new Error("checked-out commit is not the release tag");
const prerelease = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(manifest.version);
if (!prerelease && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("package version must be full SemVer");
}
if (prerelease !== releasePrerelease) {
  throw new Error("GitHub prerelease state does not match package SemVer");
}
for (const [label, pattern] of [
  ["component version", new RegExp(manifest.version.replaceAll(".", "\\."))],
  ["supported protocol", /protocol(?:s| version)?[^\n]*\b1\b/i],
  ["schema migration impact", /schema[^\n]*(?:migration|unchanged|none)/i],
  ["rollback requirements", /rollback/i],
]) {
  if (!pattern.test(releaseBody)) {
    throw new Error(`release notes must state ${label}`);
  }
}
process.stdout.write(
  `version=${manifest.version}\nprerelease=${String(prerelease)}\ndist_tag=${prerelease ? "next" : "latest"}\n`,
);
