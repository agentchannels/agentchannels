import { SUPPORTED_PROTOCOLS } from "@agentchannels/protocol";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
}

const [release] = git("tag", "--list", "cli-v*", "--sort=-v:refname").split(
  "\n",
);

if (release === undefined || release === "") {
  console.log(
    "No CLI has been released, so there is no deployed client to pair with.",
  );
  process.exit(0);
}

const source = git("show", `${release}:packages/protocol/src/messages.ts`);
const declared = /export const PROTOCOL = (\d+);/.exec(source)?.[1];
if (declared === undefined)
  throw new Error(`${release} does not declare a protocol version.`);

const protocol = Number(declared);
const { min, max } = SUPPORTED_PROTOCOLS;
if (protocol < min || protocol > max) {
  console.error(
    `${release} speaks protocol ${String(protocol)}, but this relay supports ${String(min)}-${String(max)}. Deploying would disconnect every installation on that release.`,
  );
  process.exit(1);
}
console.log(
  `${release} speaks protocol ${String(protocol)}, which this relay supports.`,
);
