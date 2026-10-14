/**
 * The pi skills the conversation is not offered, because turri has them already.
 *
 * pi lists for the conversation every skill it finds: `~/.pi/agent/skills`, `~/.agents/skills`, and the `.agents/skills`
 * of every folder from the one turri started in up to its git root - so a folder above a project can hand the chat
 * another tool's ***plain skills, a `load-plain-reference` it then loads at the start of a session. turri needs none of
 * them: the whole ***plain reference - the authoring rules - is in the conversation's system prompt already, and turri
 * runs its own skills, and the project's, with `cultivate`, steps and gates and all. A skill the chat followed by hand
 * instead would skip those gates, and one from another tool may say otherwise than turri's rules. So the conversation
 * is offered neither: no skill turri runs itself, and none about ***plain. A skill about anything else - a commit
 * message, a deploy - is offered as pi offers it.
 */

/** What a skill says it is about, that turri covers: ***plain specs and their testing scripts. */
const ABOUT_PLAIN = /\*\*\*plain|\\\*\\\*\\\*plain|\.plain\b|functional specs?\b|testing scripts?\b|run_unittests|run_conformance_tests/i;

/** Whether turri has what a pi skill offers: it runs a skill of that name itself, or the skill is about ***plain. */
export function supersededByTurri(skill: { name: string; description: string }, turriRuns: ReadonlySet<string>): boolean {
  return turriRuns.has(skill.name) || ABOUT_PLAIN.test(`${skill.name} ${skill.description}`);
}
