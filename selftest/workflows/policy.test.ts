import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Mapping = Record<string, unknown>;

const repoRoot = resolve(import.meta.dir, "..", "..");

const readText = (relativePath: string): string => readFileSync(resolve(repoRoot, relativePath), "utf8");

const readMapping = (relativePath: string): Mapping => {
  const parsed = Bun.YAML.parse(readText(relativePath));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${relativePath} must be a YAML mapping`);
  }
  return parsed as Mapping;
};

const globYaml = (pattern: string): string[] =>
  Array.from(new Bun.Glob(pattern).scanSync({ cwd: repoRoot })).sort();

const workflowFiles = globYaml(".github/workflows/*.yml");
const actionFiles = globYaml("actions/**/*.yml");

const asMapping = (value: unknown): Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Mapping) : {};

type WalkVisitor = (map: Mapping, trail: string[]) => void;

const walk = (node: unknown, visit: WalkVisitor, trail: string[] = []): void => {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, visit, [...trail, `[${index}]`]));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const map = node as Mapping;
  visit(map, trail);
  for (const [key, value] of Object.entries(map)) walk(value, visit, [...trail, key]);
};

type UseEntry = { file: string; where: string; ref: string };
type CheckoutEntry = { file: string; where: string; credentials: unknown };

const collectUses = (): { uses: UseEntry[]; checkouts: CheckoutEntry[]; keys: Map<string, string[]> } => {
  const uses: UseEntry[] = [];
  const checkouts: CheckoutEntry[] = [];
  const keys = new Map<string, string[]>();
  for (const file of [...workflowFiles, ...actionFiles]) {
    walk(readMapping(file), (map, trail) => {
      const where = `${file} ${trail.join(".") || "<root>"}`;
      const fileKeys = keys.get(file) ?? [];
      for (const key of Object.keys(map)) fileKeys.push(key);
      keys.set(file, fileKeys);
      const ref = map.uses;
      if (typeof ref !== "string") return;
      uses.push({ file, where, ref });
      if (ref.startsWith("actions/checkout@")) {
        checkouts.push({ file, where, credentials: asMapping(map.with)["persist-credentials"] });
      }
    });
  }
  return { uses, checkouts, keys };
};

const collected = collectUses();

const prDefinition = readMapping(".github/workflows/pr.yml");
const prTriggers = asMapping(prDefinition.on);
const prJobs = asMapping(prDefinition.jobs);

const jobSteps = (job: Mapping): Mapping[] => (Array.isArray(job.steps) ? job.steps.map(asMapping) : []);

const stepMatching = (steps: Mapping[], prefix: string): Mapping | undefined =>
  steps.find((step) => typeof step.uses === "string" && step.uses.startsWith(prefix));

describe("scan scope", () => {
  test("every workflow and action in this repository is scanned", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(actionFiles.length).toBeGreaterThan(0);
    expect(workflowFiles).toContain(".github/workflows/pr.yml");
    expect(actionFiles).toContain("actions/mise-check/action.yml");
  });
});

describe("external action refs", () => {
  test("every non-local uses tracks @main instead of a pinned version", () => {
    const external = collected.uses.filter(({ ref }) => !ref.startsWith("./"));
    expect(external.length).toBeGreaterThan(0);
    const violations = external
      .filter(({ ref }) => !ref.endsWith("@main"))
      .map(({ where, ref }) => `${where}: external ref '${ref}' must track @main (no pinned version)`);
    expect(violations).toEqual([]);
  });
});

describe("actions/checkout", () => {
  test("every checkout declares persist-credentials: false", () => {
    expect(collected.checkouts.length).toBeGreaterThan(0);
    const violations = collected.checkouts
      .filter(({ credentials }) => credentials !== false && credentials !== "false")
      .map(
        ({ where, credentials }) =>
          `${where}: actions/checkout must declare persist-credentials: false (got ${JSON.stringify(credentials)})`,
      );
    expect(violations).toEqual([]);
  });
});

describe("pr.yml", () => {
  test("triggers pull_request on main and tree/** plus merge_group", () => {
    expect(Object.keys(prTriggers).sort()).toEqual(["merge_group", "pull_request"]);
    const pullRequest = asMapping(prTriggers.pull_request);
    expect(Object.keys(pullRequest)).toEqual(["branches"]);
    expect(pullRequest.branches).toEqual(["main", "tree/**"]);
  });

  test("exposes exactly one hosted job named test", () => {
    expect(Object.keys(prJobs)).toEqual(["test"]);
    const job = asMapping(prJobs.test);
    expect(job.name).toBe("test");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
  });

  test("checks out without credentials and runs the check:pr task", () => {
    const steps = jobSteps(asMapping(prJobs.test));
    expect(asMapping(stepMatching(steps, "actions/checkout@")?.with)["persist-credentials"]).toBe(false);
    const miseCheck = stepMatching(steps, "./actions/mise-check");
    expect(miseCheck).toBeDefined();
    expect(asMapping(miseCheck?.with).task).toBe("check:pr");
  });

  test("carries no path filters or continue-on-error", () => {
    const keys = collected.keys.get(".github/workflows/pr.yml") ?? [];
    expect(keys.filter((key) => key === "paths" || key === "paths-ignore")).toEqual([]);
    expect(keys.filter((key) => key === "continue-on-error")).toEqual([]);
  });
});

describe("self-check.yml", () => {
  test("runs on main and tree/** pushes instead of pull requests", () => {
    const triggers = asMapping(readMapping(".github/workflows/self-check.yml").on);
    expect(Object.keys(triggers)).toEqual(["push"]);
    expect(asMapping(triggers.push).branches).toEqual(["main", "tree/**"]);
  });
});

describe("cross-repo pull request rejection", () => {
  type ScriptResult = { status: number | null; output: string };

  const runScript = (script: string, env: Record<string, string>, withCurlStub = false): ScriptResult => {
    const dir = mkdtempSync(join(tmpdir(), "ci-policy-"));
    try {
      const scriptPath = join(dir, "step.sh");
      writeFileSync(scriptPath, script);
      const externalCall = '#!/usr/bin/env bash\necho "unexpected external call: $0" >&2\nexit 99\n';
      for (const command of ["gh", "docker", "skopeo"]) {
        writeFileSync(join(dir, command), externalCall, { mode: 0o755 });
      }
      writeFileSync(
        join(dir, "curl"),
        withCurlStub ? '#!/usr/bin/env bash\nprintf \'{"sha":"%s"}\\n\' "${STUB_SHA:-stub}"\n' : externalCall,
        { mode: 0o755 },
      );
      const result = Bun.spawnSync({
        cmd: ["bash", "--noprofile", "--norc", "-eo", "pipefail", scriptPath],
        env: {
          ...process.env,
          ...env,
          GITHUB_OUTPUT: join(dir, "github-output"),
          GITHUB_STEP_SUMMARY: join(dir, "step-summary"),
          PATH: `${dir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { status: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const stepMapping = (file: string, jobId: string, stepId: string): Mapping => {
    const job = asMapping(asMapping(readMapping(file).jobs)[jobId]);
    const step = jobSteps(job).find((candidate) => candidate.id === stepId);
    if (step === undefined) throw new Error(`${file} ${jobId}.${stepId} is missing`);
    return step;
  };

  const stepScript = (file: string, jobId: string, stepId: string): string => {
    const script = stepMapping(file, jobId, stepId).run;
    if (typeof script !== "string") throw new Error(`${file} ${jobId}.${stepId} has no run script`);
    if (script.includes("${{")) {
      throw new Error(file + " " + jobId + "." + stepId + " expands ${{ }} inside run; this probe executes it verbatim");
    }
    return script;
  };

  const pullRequest = {
    EVENT_NAME: "pull_request",
    HEAD_REPO: "other/repo",
    REPO: "me/repo",
    SHA: "deadbeef",
  };
  const selfHosted = '["self-hosted","linux"]';
  const selfHostedMixedCase = '["Self-Hosted","linux"]';
  const hosted = '["ubuntu-24.04"]';
  const pullRequestEvents = ["pull_request", "pull_request_target"];
  const rejected = "must not run on self-hosted runners of me/repo";

  const probes = [
    {
      file: ".github/workflows/check.yml",
      job: "parse",
      step: "parse",
      rejected,
      curlStub: false,
      env: (runsOn: string): Record<string, string> => ({
        ...pullRequest,
        IN_RUNS_ON: runsOn,
        IN_REF: "",
        IN_TASK: "check",
      }),
    },
    {
      file: ".github/workflows/image.yml",
      job: "parse",
      step: "parse",
      rejected,
      curlStub: false,
      env: (runsOn: string): Record<string, string> => ({
        ...pullRequest,
        IN_RUNS_ON: runsOn,
        IN_REF: "",
        IN_MODE: "build-only",
        IN_IMAGES: "registry.237575.xyz/ci-selftest/alpha",
        IN_TAG: "selftest",
        IN_CHANNEL: "",
        IN_DEPLOYMENT_ENVIRONMENT: "",
        IN_VERSION_FILE: "",
        IN_VERSION_KEY: "",
        HAS_REGISTRY_SECRET: "false",
        OWNER: "me",
      }),
    },
    {
      file: ".github/workflows/release-artifact.yml",
      job: "parse",
      step: "parse",
      rejected,
      curlStub: true,
      env: (runsOn: string): Record<string, string> => ({
        ...pullRequest,
        IN_PLATFORMS: `[{"name":"alpha","runs-on":${runsOn}}]`,
        IN_REF: "",
        IN_MODE: "build-only",
        IN_TAG: "",
        GH_TOKEN: "stub",
        API: "https://api.invalid/repos/me/repo",
        GITHUB_RUN_ATTEMPT: "1",
        STUB_SHA: "deadbeef",
      }),
    },
  ];

  test("every workflow with a caller-controlled runs-on is probed for the rejection", () => {
    const discovered = workflowFiles
      .filter((file) => {
        const jobs = asMapping(readMapping(file).jobs);
        return Object.values(jobs).some((job) => {
          const runsOn = asMapping(job)["runs-on"];
          const labels = Array.isArray(runsOn) ? runsOn : [runsOn];
          return labels.some((label) => typeof label === "string" && label.includes("${{"));
        });
      })
      .sort();
    expect(discovered.length).toBeGreaterThan(0);
    expect(
      [...new Set(probes.map((probe) => probe.file))].sort(),
      `probe these caller-controlled workflows: ${discovered.join(", ")}`,
    ).toEqual(discovered);
  });

  for (const probe of probes) {
    test(`${probe.file} rejects a fork pull request on self-hosted runners`, () => {
      const script = stepScript(probe.file, probe.job, probe.step);
      const declared = Object.keys(asMapping(stepMapping(probe.file, probe.job, probe.step).env));
      expect(declared.filter((key) => !(key in probe.env(selfHosted)))).toEqual([]);
      for (const event of pullRequestEvents) {
        for (const runsOn of [selfHosted, selfHostedMixedCase]) {
          const result = runScript(script, { ...probe.env(runsOn), EVENT_NAME: event }, probe.curlStub);
          expect(result.status).not.toBe(0);
          expect(result.output).toContain(probe.rejected);
        }
      }
    });

    test(`${probe.file} allows a fork pull request on GitHub-hosted runners`, () => {
      const script = stepScript(probe.file, probe.job, probe.step);
      for (const event of pullRequestEvents) {
        const result = runScript(script, { ...probe.env(hosted), EVENT_NAME: event }, probe.curlStub);
        expect(result.status).toBe(0);
        expect(result.output).not.toContain("must not run on");
      }
    });
  }

  const guardScript = readText("actions/mise-check/guard.sh");
  const guardEnv = (overrides: Record<string, string>): Record<string, string> => ({
    TASK: "check",
    EVENT_NAME: "pull_request",
    HEAD_REPO: "other/repo",
    REPO: "me/repo",
    RUNNER_ENVIRONMENT: "self-hosted",
    ...overrides,
  });

  test("actions/mise-check/guard.sh rejects a fork pull request off a GitHub-hosted runner", () => {
    const result = runScript(guardScript, guardEnv({}));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("must not run on a self-hosted runner of me/repo");
    const unknown = runScript(guardScript, guardEnv({ RUNNER_ENVIRONMENT: "" }));
    expect(unknown.status).not.toBe(0);
    expect(unknown.output).toContain("must not run on a unknown runner of me/repo");
  });

  test("actions/mise-check/guard.sh allows a fork pull request on a GitHub-hosted runner", () => {
    const result = runScript(guardScript, guardEnv({ RUNNER_ENVIRONMENT: "github-hosted" }));
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("must not run on");
  });

  test("actions/mise-check/guard.sh allows a same-repository pull request on a self-hosted runner", () => {
    const result = runScript(guardScript, guardEnv({ HEAD_REPO: "me/repo" }));
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("must not run on");
  });
});

describe("mise tasks", () => {
  const tasks = asMapping(asMapping(Bun.TOML.parse(readText("mise.toml"))).tasks);

  test("check:pr lints workflows and runs the policy self-test", () => {
    expect(asMapping(tasks["check:pr"]).run).toBe("actionlint && bun test selftest");
  });

  test("check is a superset of check:pr", () => {
    expect(asMapping(tasks.check).depends).toEqual(["check:pr"]);
    expect(asMapping(tasks.check).run).toBeUndefined();
  });
});
