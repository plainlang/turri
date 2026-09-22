import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";

/**
 * The gate syntax.
 *
 * Everything below lives under `metadata:` in SKILL.md frontmatter, which the
 * Agent Skills spec reserves for arbitrary key-values. A harness that does not
 * understand it ignores it and the skill degrades to plain prose. Ours parses
 * it and turns each gate into an edge in the graph, so the gate is enforced by
 * code rather than by the model deciding to honour a paragraph.
 */
export type OnFail = "retry" | "escalate" | "abort";
export type Quorum = "all" | "majority" | "any";

export interface ReviewSpec {
  /** Path to the rubric, relative to the skill directory. */
  rubric: string;
  /** Independent judge sessions. Separate sessions, not n samples of one. */
  judges: number;
  /** "provider/model-id". Omitted: same model as the executor. */
  model?: string;
  /**
   * Read-only tools the judges may use.
   *
   * A rubric that checks what is on disk needs to look at the disk. Judges get nothing by
   * default, so a gate has to ask for this explicitly, and should ask only for tools that
   * cannot change anything.
   */
  judgeTools: string[];
  quorum: Quorum;
  onFail: OnFail;
  maxRetries: number;
}

export interface GateSpec {
  /** Name of the step this gate guards. */
  after: string;
  review: ReviewSpec;
}

export interface StepSpec {
  name: string;
  /** Prose under the step's heading - this is what the executor is told to do. */
  instructions: string;
  gate?: GateSpec;
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  allowedTools: string[];
  steps: StepSpec[];
}

interface RawGate {
  after?: string;
  review?: Partial<ReviewSpec> & { max_retries?: number; on_fail?: OnFail };
}

const REVIEW_DEFAULTS = {
  judges: 2,
  quorum: "all" as Quorum,
  onFail: "retry" as OnFail,
  maxRetries: 2,
};

/**
 * Parse `### step-name` headings under the `## Steps` section, in order, with their prose.
 *
 * Only that section counts. A skill written as prose usually has `###` headings of its own,
 * and treating those as executable steps would run its explanatory subsections as work. The
 * `## Steps` heading is what marks a skill as converted to this format; without it the skill
 * does not load, which is the honest answer rather than a plausible-looking wrong one.
 */
function parseSteps(body: string): Array<{ name: string; instructions: string }> {
  const stepsHeading = /^##\s+Steps\s*$/im.exec(body);
  if (stepsHeading === null) return [];

  const afterSteps = body.slice(stepsHeading.index + stepsHeading[0].length);
  const nextSection = /^##\s+(?!#)/m.exec(afterSteps);
  const lines = (nextSection === null ? afterSteps : afterSteps.slice(0, nextSection.index)).split("\n");
  const steps: Array<{ name: string; instructions: string }> = [];
  let current: { name: string; instructions: string[] } | undefined;

  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) steps.push({ name: current.name, instructions: current.instructions.join("\n").trim() });
      current = { name: heading[1]!.trim(), instructions: [] };
      continue;
    }
    if (current) current.instructions.push(line);
  }
  if (current) steps.push({ name: current.name, instructions: current.instructions.join("\n").trim() });
  return steps;
}

export function loadSkill(skillDir: string): Skill {
  const dir = resolve(skillDir);
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  const { data, content } = matter(raw);

  const name = String(data.name ?? "");
  const description = String(data.description ?? "");
  if (!name || !description) {
    throw new Error(`${dir}/SKILL.md: 'name' and 'description' are required by the Agent Skills spec`);
  }

  const rawGates: RawGate[] = (data.metadata as any)?.gates ?? [];
  const gatesByStep = new Map<string, GateSpec>();
  for (const g of rawGates) {
    if (!g.after) throw new Error(`${name}: every gate needs an 'after: <step>'`);
    if (!g.review?.rubric) throw new Error(`${name}: gate after '${g.after}' has no 'review.rubric'`);
    gatesByStep.set(g.after, {
      after: g.after,
      review: {
        rubric: g.review.rubric,
        judges: g.review.judges ?? REVIEW_DEFAULTS.judges,
        model: g.review.model,
        quorum: g.review.quorum ?? REVIEW_DEFAULTS.quorum,
        judgeTools: (g.review as { judge_tools?: string[] }).judge_tools ?? g.review.judgeTools ?? [],
        onFail: g.review.on_fail ?? g.review.onFail ?? REVIEW_DEFAULTS.onFail,
        maxRetries: g.review.max_retries ?? g.review.maxRetries ?? REVIEW_DEFAULTS.maxRetries,
      },
    });
  }

  const steps = parseSteps(content).map<StepSpec>((s) => ({ ...s, gate: gatesByStep.get(s.name) }));
  if (steps.length === 0) {
    throw new Error(`${name}: no '## Steps' section with '### <step>' headings - not converted to the gated format`);
  }

  for (const stepName of gatesByStep.keys()) {
    if (!steps.some((s) => s.name === stepName)) {
      throw new Error(`${name}: gate references unknown step '${stepName}'`);
    }
  }

  return {
    name,
    description,
    dir,
    allowedTools: (data["allowed-tools"] as string[]) ?? [],
    steps,
  };
}

export function readRubric(skill: Skill, review: ReviewSpec): string {
  return readFileSync(join(skill.dir, review.rubric), "utf8").trim();
}
