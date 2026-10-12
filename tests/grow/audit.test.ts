import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterCommand, beforeCommand, type AuditScope } from "../../src/grow/audit.ts";
import { conversationCommand, conversationWriting, resetConversationWrites } from "../../src/grow/conversation-writes.ts";
import { applySpecDiff } from "../../src/grow/regenerate.ts";

/**
 * The audit after every agent command, on every platform: what the role may not change inside the project is put
 * back as it was - a changed file restored, a new one removed, a deleted one brought back - and the agent told. Its
 * own work is left alone.
 */

let project: string;
let app: string;
let web: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-audit-")));
  app = join(project, "plain_modules", "app");
  web = join(project, "plain_modules", "web");
  for (const dir of [join(app, "code"), join(app, "tests"), join(web, "code"), join(project, "test_scripts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "app.plain"), "***definitions***\n- :App: is an app.\n");
  writeFileSync(join(project, "config.yaml"), "coding-model: x\n");
  writeFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "python3 -m unittest\n");
  writeFileSync(join(project, ".env"), "D365_SECRET=s3cr3t\n");
  writeFileSync(join(app, "code", "app.py"), "print('mine')\n");
  writeFileSync(join(app, "code", ".turri.json"), '{"frids":["1"]}\n');
  writeFileSync(join(web, "code", "web.py"), "print('theirs')\n");
  writeFileSync(join(web, "code", "keep.py"), "keep = 1\n");
  for (const module of [app, web]) {
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", join(module, ".plaingit"), "--work-tree", module, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "built");
  }
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  resetConversationWrites();
});

/** The coding agent's scope: it writes its module's code. */
const coder = (): AuditScope => ({ project, module: app, write: [join(app, "code")], readOnly: [] });

describe("what the role may not change", () => {
  it("puts back the specs, the config and the testing scripts - changed, deleted or added to", () => {
    const before = beforeCommand(coder());
    writeFileSync(join(project, "app.plain"), "***definitions***\n- :App: is something else.\n");
    unlinkSync(join(project, "config.yaml"));
    writeFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "exit 0\n");
    writeFileSync(join(project, "extra.plain"), "made up\n");
    const result = afterCommand(before);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toBe("***definitions***\n- :App: is an app.\n");
    expect(readFileSync(join(project, "config.yaml"), "utf8")).toBe("coding-model: x\n");
    expect(readFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "utf8")).toBe("python3 -m unittest\n");
    expect(existsSync(join(project, "extra.plain"))).toBe(false);
    expect(result.putBack.sort()).toEqual(["app.plain", "config.yaml", "extra.plain", "test_scripts/run_unittests_python.sh"]);
  });

  it("puts back a credential file anywhere in the project, its own folder included", () => {
    const before = beforeCommand(coder());
    writeFileSync(join(project, ".env"), "D365_SECRET=dummy\n");
    writeFileSync(join(app, "code", ".env"), "API_KEY=dummy\n");
    const result = afterCommand(before);
    expect(readFileSync(join(project, ".env"), "utf8")).toBe("D365_SECRET=s3cr3t\n");
    expect(existsSync(join(app, "code", ".env"))).toBe(false);
    expect(result.putBack.sort()).toEqual([".env", "plain_modules/app/code/.env"]);
  });

  it("puts back the code record, which is in the agent's own folder", () => {
    const before = beforeCommand(coder());
    writeFileSync(join(app, "code", ".turri.json"), '{"frids":["1","2"]}\n');
    afterCommand(before);
    expect(readFileSync(join(app, "code", ".turri.json"), "utf8")).toBe('{"frids":["1"]}\n');
  });

  it("puts another module back as its last commit has it", () => {
    const before = beforeCommand(coder());
    writeFileSync(join(web, "code", "web.py"), "print('mine now')\n");
    unlinkSync(join(web, "code", "keep.py"));
    writeFileSync(join(web, "code", "new.py"), "x = 1\n");
    const result = afterCommand(before);
    expect(readFileSync(join(web, "code", "web.py"), "utf8")).toBe("print('theirs')\n");
    expect(readFileSync(join(web, "code", "keep.py"), "utf8")).toBe("keep = 1\n");
    expect(existsSync(join(web, "code", "new.py"))).toBe(false);
    expect(result.putBack.sort()).toEqual(["plain_modules/web/code/keep.py", "plain_modules/web/code/new.py", "plain_modules/web/code/web.py"]);
  });

  it("leaves another module a pulse is working in, and says so in the log only", () => {
    const before = beforeCommand({ ...coder(), busy: (module) => module === web });
    writeFileSync(join(web, "code", "web.py"), "print('their pulse wrote this')\n");
    const result = afterCommand(before);
    expect(readFileSync(join(web, "code", "web.py"), "utf8")).toBe("print('their pulse wrote this')\n");
    expect(result.putBack).toEqual([]);
    expect(result.left).toEqual(["plain_modules/web/code/web.py"]);
  });

  it("puts back the module's lineage", () => {
    const head = join(app, ".plaingit", "HEAD");
    const before = beforeCommand(coder());
    const was = readFileSync(head, "utf8");
    writeFileSync(head, "ref: refs/heads/elsewhere\n");
    afterCommand(before);
    expect(readFileSync(head, "utf8")).toBe(was);
  });

  it("puts back a folder the role only reads, and leaves the one it writes", () => {
    // The conformance agent: writes its tests, reads the code - which may hold this pulse's work, not yet committed.
    writeFileSync(join(app, "code", "app.py"), "print('work in progress')\n");
    const before = beforeCommand({ project, module: app, write: [join(app, "tests")], readOnly: [join(app, "code")] });
    writeFileSync(join(app, "code", "app.py"), "print('changed by the tests agent')\n");
    writeFileSync(join(app, "code", "helper.py"), "y = 2\n");
    writeFileSync(join(app, "tests", "test_app.py"), "def test(): pass\n");
    afterCommand(before);
    expect(readFileSync(join(app, "code", "app.py"), "utf8")).toBe("print('work in progress')\n");
    expect(existsSync(join(app, "code", "helper.py"))).toBe(false);
    expect(readFileSync(join(app, "tests", "test_app.py"), "utf8")).toBe("def test(): pass\n");
  });

  it("puts back the part of its own module its role does not write - the coding agent's conformance tests", () => {
    writeFileSync(join(app, "tests", "test_conformance.py"), "def test_it(): assert True\n");
    const before = beforeCommand(coder());
    writeFileSync(join(app, "tests", "test_conformance.py"), "def test_it(): pass\n");
    const result = afterCommand(before);
    expect(readFileSync(join(app, "tests", "test_conformance.py"), "utf8")).toBe("def test_it(): assert True\n");
    expect(result.putBack).toEqual(["plain_modules/app/tests/test_conformance.py"]);
  });
});

describe("what the conversation changes while an agent's command runs", () => {
  it("leaves a spec the conversation edited meanwhile, and still puts back what the command changed", () => {
    const before = beforeCommand(coder());
    // The person's model edits the spec while the agent's command runs - and the command changes the config.
    const done = conversationWriting([join(project, "app.plain")]);
    writeFileSync(join(project, "app.plain"), "***definitions***\n- :App: is an app the person changed.\n");
    done();
    writeFileSync(join(project, "config.yaml"), "coding-model: changed\n");
    const result = afterCommand(before);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toContain("the person changed");
    expect(result.conversation).toEqual(["app.plain"]);
    expect(result.putBack).toEqual(["config.yaml"]);
  });

  it("puts back a spec the conversation wrote before the command began, as the command's change", () => {
    conversationWriting([join(project, "app.plain")])();
    // A moment later: the command begins after the conversation's write has ended.
    const ended = Date.now();
    while (Date.now() <= ended) {
      /* wait for the clock to move on */
    }
    const before = beforeCommand(coder());
    writeFileSync(join(project, "app.plain"), "changed by the command\n");
    expect(afterCommand(before).putBack).toEqual(["app.plain"]);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toBe("***definitions***\n- :App: is an app.\n");
  });

  it("leaves what changes while a command of the conversation's own runs - what it writes cannot be known", () => {
    const before = beforeCommand(coder());
    const done = conversationCommand();
    writeFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "python3 -m pytest\n");
    const result = afterCommand(before);
    done();
    expect(result.conversation).toEqual(["test_scripts/run_unittests_python.sh"]);
    expect(readFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "utf8")).toBe("python3 -m pytest\n");
  });

  it("leaves a spec diff the conversation applied meanwhile", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const before = beforeCommand(coder());
    applySpecDiff("--- a/app.plain\n+++ b/app.plain\n@@ -1,2 +1,2 @@\n ***definitions***\n-- :App: is an app.\n+- :App: is a better app.\n", project);
    const result = afterCommand(before);
    expect(result.conversation).toEqual(["app.plain"]);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toContain("a better app");
  });
});

describe("what the role may change", () => {
  it("is left alone: its own code, its installed dependencies, its notes", () => {
    const before = beforeCommand(coder());
    writeFileSync(join(app, "code", "app.py"), "print('better')\n");
    mkdirSync(join(app, "code", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(app, "code", "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(app, "code", ".turri-notes.md"), "- a note\n");
    const result = afterCommand(before);
    expect(result).toEqual({ putBack: [], left: [], lost: [], conversation: [] });
    expect(readFileSync(join(app, "code", "app.py"), "utf8")).toBe("print('better')\n");
  });
});

describe("what the agent is told", () => {
  it("names what was put back, and why - and nothing at all when nothing was", async () => {
    const { auditMessage } = await import("../../src/grow/audit.ts");
    expect(auditMessage({ putBack: [], left: [], lost: [], conversation: [] })).toBeUndefined();
    const message = auditMessage({ putBack: ["app.plain", "plain_modules/web/code/web.py"], left: [], lost: [], conversation: [] })!;
    expect(message).toContain("turri put back app.plain, plain_modules/web/code/web.py");
    expect(message).toMatch(/outside what you may change/);
  });
});
