import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  test("check.yml keeps the self-hosted rejection in its parse job", () => {
    const parseJob = asMapping(asMapping(readMapping(".github/workflows/check.yml").jobs).parse);
    const parse = jobSteps(parseJob).find((step) => step.id === "parse");
    expect(parse).toBeDefined();
    const env = asMapping(parse?.env);
    expect(env).toHaveProperty("HEAD_REPO");
    expect(env).toHaveProperty("REPO");
    const script = String(parse?.run);
    for (const fragment of [
      "pull_request|pull_request_target",
      '[ "$HEAD_REPO" != "$REPO" ]',
      'ascii_downcase == "self-hosted"',
      "fail runs-on",
    ]) {
      expect(script).toContain(fragment);
    }
  });

  test("actions/mise-check keeps the off-hosted rejection in its guard", () => {
    const guard = readText("actions/mise-check/guard.sh");
    for (const fragment of [
      "pull_request|pull_request_target",
      '"${HEAD_REPO:-}" != "${REPO:-}"',
      "github-hosted",
      "fail runner",
    ]) {
      expect(guard).toContain(fragment);
    }
  });
});

describe("mise tasks", () => {
  const tasks = asMapping(asMapping(Bun.TOML.parse(readText("mise.toml"))).tasks);

  test("check:pr runs the policy self-test", () => {
    expect(asMapping(tasks["check:pr"]).run).toBe("bun test selftest");
  });

  test("check includes actionlint and check:pr", () => {
    expect(asMapping(tasks.check).depends).toEqual(["check:pr"]);
    expect(String(asMapping(tasks.check).run)).toContain("actionlint");
  });
});
