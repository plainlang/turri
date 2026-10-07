import { describe, expect, it } from "vitest";
import { askedForCommandLine, refusal, selfInvocation } from "../src/self-invocation.ts";

describe("a shell command that runs turri again", () => {
  it("is caught in every form it is written", () => {
    expect(selfInvocation("turri module app.plain --model openai/gpt-5.5")).toBe("module");
    expect(selfInvocation("cd ~/proj && turri render app.plain 2")).toBe("render");
    expect(selfInvocation("nohup turri regenerate app.plain 3 > log 2>&1 &")).toBe("regenerate");
    expect(selfInvocation("npx turri conformance app.plain 1")).toBe("conformance");
    expect(selfInvocation("node bin/turri.mjs skill genome/skills/brood")).toBe("skill");
    expect(selfInvocation("npm run regrow -- app.plain")).toBe("regrow");
    expect(selfInvocation("npx tsx src/regrow-cli.ts app.plain 1")).toBe("regrow");
    expect(selfInvocation("turri regrow app.plain")).toBe("regrow");
    expect(selfInvocation("turri glimpse app.plain")).toBe("glimpse");
    expect(selfInvocation("turri bind app.plain 2")).toBe("bind");
    expect(selfInvocation("turri release app.plain")).toBe("release");
    expect(selfInvocation('pi -p "build it"')).toBe("pi");
    expect(selfInvocation("turri chat -p 'render the module'")).toBe("chat");
    expect(selfInvocation("turri -p 'render the module'")).toBe("chat");
    expect(selfInvocation("cd ~/proj && turri")).toBe("chat");
    expect(selfInvocation("nohup turri --harness-model x -p go > log 2>&1 &")).toBe("chat");
    expect(selfInvocation("node bin/turri.mjs -c")).toBe("chat");
    expect(selfInvocation("turri deploy app.plain")).toBe("deploy");
  });

  it("lets pi configure and describe itself, and catches it starting an agent", () => {
    for (const ok of ["pi install npm:some-extension", "pi update", "pi list", "pi config", "pi auth status", "pi --version", "pi --list-models", "pi remove ./ext -l"]) {
      expect(selfInvocation(ok)).toBeUndefined();
    }
    for (const agent of ["pi", 'pi "build the module"', "pi --mode rpc", "pi -c", "pi --model openai/gpt-5.5 -p hi", "pi update && pi -p go"]) {
      expect(selfInvocation(agent)).toBe("pi");
    }
  });

  it("leaves everything else alone", () => {
    expect(selfInvocation("turri validate app.plain")).toBeUndefined();
    expect(selfInvocation("turri validate app.plain")).toBeUndefined();
    expect(selfInvocation("turri drift app.plain")).toBeUndefined();
    expect(selfInvocation("turri doctor")).toBeUndefined();
    expect(selfInvocation("turri --help")).toBeUndefined();
    expect(selfInvocation("which turri")).toBeUndefined();
    expect(selfInvocation("ls ~/.turri")).toBeUndefined();
    expect(selfInvocation("pip install requests")).toBeUndefined();
    expect(selfInvocation("python3 -m pytest")).toBeUndefined();
    expect(selfInvocation("grep -rn turri README.md")).toBeUndefined();
    expect(selfInvocation("cat plain_modules/app/code/render.py")).toBeUndefined();
    expect(selfInvocation("npm run test")).toBeUndefined();
  });

  it("is refused with the tool to use instead", () => {
    expect(refusal("module")).toContain("Use regrow instead.");
    expect(refusal("deploy")).toContain("Use release instead.");
    expect(refusal("pi")).toContain("Do not start another agent");
  });
});

describe("whether the person asked for the command line", () => {
  it("is yes when they say so, or name the command", () => {
    expect(askedForCommandLine("run it headless overnight")).toBe(true);
    expect(askedForCommandLine("use the CLI for this")).toBe(true);
    expect(askedForCommandLine("run turri regrow app.plain in the terminal")).toBe(true);
    expect(askedForCommandLine("turri regrow app.plain 3 please")).toBe(true);
  });

  it("is no for an ordinary request", () => {
    expect(askedForCommandLine("build the whole module")).toBe(false);
    expect(askedForCommandLine("render functionality 3 again")).toBe(false);
    expect(askedForCommandLine("regenerate the export")).toBe(false);
  });
});
