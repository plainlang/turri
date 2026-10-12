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

/**
 * A reviewer that runs while the step is still running.
 *
 * A gate at the end of a phase only finds a problem once the whole phase is written, and
 * in a phase that builds as it goes that is far too late: functionality 7 is already built
 * on top of the mistake in functionality 3. A continuous reviewer watches the work as it
 * lands and reports between questions, so the interview never blocks on it and the final
 * gate normally has nothing left to find.
 *
 * It only works for a step that *adds*: every pass reviews what appeared since the last
 * clean one, and earlier work is not rewritten underneath it.
 */
export interface ContinuousSpec {
  /** Rubric for the live pass. Checks what is on disk, not the phase record. */
  rubric: string;
  /** Judges per pass. One by default: this runs many times, the final gate runs once. */
  judges: number;
  model?: string;
  judgeTools: string[];
}

export interface GateSpec {
  /** Name of the step this gate guards. */
  after: string;
  review: ReviewSpec;
  /** Reviews the work as it is written, rather than waiting for the step to end. */
  continuous?: ContinuousSpec;
}

export interface StepSpec {
  name: string;
  /** Prose under the step's heading - this is what the executor is told to do. */
  instructions: string;
  /** What the step does, in a short line for the person - shown under the skill's progress while it runs. */
  about?: string;
  gate?: GateSpec;
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  allowedTools: string[];
  steps: StepSpec[];
  /**
   * Whether `write_spec_diff` needs an answer from the user between two new changes - one answer,
   * one change, as an interview writes them. `metadata.paced: false` turns it off, for a skill that
   * writes the specs on its own.
   */
  paced: boolean;
  /**
   * The phases the questioning level caps (`metadata.questioning`, questioning.ts): when there are any, the harness asks
   * the level first, and each of them asks at most as many questions as it allows. Empty: no level is asked.
   */
  questioning: string[];
  /**
   * The steps where each answer is a spec change (`metadata.spec-diff-per-answer`): the next question waits until the
   * last answer is written with `write_spec_diff`, and changes the agent decides itself need no answer before them.
   */
  diffPerAnswer: string[];
}

interface RawContinuous {
  rubric?: string;
  judges?: number;
  model?: string;
  judge_tools?: string[];
  judgeTools?: string[];
}

interface RawGate {
  after?: string;
  continuous?: RawContinuous;
  review?: Partial<ReviewSpec> & { max_retries?: number; on_fail?: OnFail };
}

const REVIEW_DEFAULTS = {
  judges: 2,
  quorum: "all" as Quorum,
  onFail: "retry" as OnFail,
  maxRetries: 2,
};

/**
 * Parse the skill's steps.
 *
 * A `## Steps` section declares them explicitly: each `###` heading under it is a step.
 * Without that section the whole skill is one step - which is what most skills are, and
 * what the Agent Skills standard describes. Steps are never inferred from arbitrary `###`
 * headings elsewhere in the body: prose skills are full of those, and reading them as
 * executable steps would run a skill's explanatory subsections as work.
 */
function parseSteps(name: string, body: string): Array<{ name: string; instructions: string }> {
  const stepsHeading = /^##\s+Steps\s*$/im.exec(body);
  if (stepsHeading === null) {
    const instructions = body.trim();
    return instructions === "" ? [] : [{ name, instructions }];
  }

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
    const live = g.continuous;
    if (live !== undefined && !live.rubric) {
      throw new Error(`${name}: continuous review after '${g.after}' has no 'rubric'`);
    }

    gatesByStep.set(g.after, {
      after: g.after,
      continuous:
        live === undefined
          ? undefined
          : {
              rubric: live.rubric!,
              // One judge per pass. The pass runs on every write, so a second opinion
              // costs a multiple of the phase rather than a single review.
              judges: live.judges ?? 1,
              model: live.model,
              judgeTools: live.judge_tools ?? live.judgeTools ?? [],
            },
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

  // What each step does, for the person: `metadata.phases`, a short line a step by its name.
  const rawPhases = (data.metadata as { phases?: unknown } | undefined)?.phases ?? {};
  if (typeof rawPhases !== "object" || rawPhases === null || Array.isArray(rawPhases)) {
    throw new Error(`${name}: 'metadata.phases' is a line a step, by the step's name`);
  }
  const abouts = new Map(Object.entries(rawPhases as Record<string, unknown>).map(([step, about]) => [step, String(about ?? "").trim()]));

  const steps = parseSteps(name, content).map<StepSpec>((s) => {
    const about = abouts.get(s.name);
    return { ...s, ...(about !== undefined && about !== "" ? { about } : {}), gate: gatesByStep.get(s.name) };
  });
  if (steps.length === 0) throw new Error(`${name}: the skill body is empty`);

  for (const stepName of abouts.keys()) {
    if (!steps.some((s) => s.name === stepName)) {
      throw new Error(`${name}: 'metadata.phases' describes unknown step '${stepName}'`);
    }
  }

  const questioning = (data.metadata as { questioning?: unknown } | undefined)?.questioning;
  const capped = Array.isArray(questioning) ? questioning.map(String) : [];
  for (const stepName of capped) {
    if (!steps.some((s) => s.name === stepName)) {
      throw new Error(`${name}: 'metadata.questioning' names unknown step '${stepName}'`);
    }
  }

  const perAnswer = (data.metadata as Record<string, unknown> | undefined)?.["spec-diff-per-answer"];
  const diffPerAnswer = Array.isArray(perAnswer) ? perAnswer.map(String) : [];
  for (const stepName of diffPerAnswer) {
    if (!steps.some((s) => s.name === stepName)) {
      throw new Error(`${name}: 'metadata.spec-diff-per-answer' names unknown step '${stepName}'`);
    }
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
    // What a skill may use is what its frontmatter names, and nothing else: no list, no tools.
    allowedTools: Array.isArray(data["allowed-tools"]) ? (data["allowed-tools"] as string[]) : [],
    steps,
    paced: (data.metadata as { paced?: unknown } | undefined)?.paced !== false,
    questioning: capped,
    diffPerAnswer,
  };
}

export function readRubric(skill: Skill, review: { rubric: string }): string {
  return readFileSync(join(skill.dir, review.rubric), "utf8").trim();
}

/**
 * The status line while a skill runs: which phase, and how far through the skill it is.
 * The phase is counted from 1 and includes the one in progress, so "3 of 6" means two are
 * done. A retry after a failed gate says so - the same phase twice is not progress.
 */
export function skillStatus(skill: Pick<Skill, "name" | "steps">, step: string, attempt: number): string {
  const index = skill.steps.findIndex((s) => s.name === step);
  const position = index === -1 ? "" : ` (phase ${index + 1} of ${skill.steps.length})`;
  const retry = attempt > 1 ? `, attempt ${attempt}` : "";
  return `${skill.name}: ${step}${position}${retry}`;
}
