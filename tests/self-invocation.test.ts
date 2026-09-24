import { describe, expect, it } from "vitest";
import { askedForCommandLine, refusal, selfInvocation } from "../src/self-invocation.ts";

describe("a shell command that runs plainwright again", () => {
  it("is caught in every form it is written", () => {
    expect(selfInvocation("plainwright module app.plain --model openai/gpt-5.5")).toBe("module");
    expect(selfInvocation("cd ~/proj && plainwright render app.plain 2")).toBe("render");
    expect(selfInvocation("nohup plainwright regenerate app.plain 3 > log 2>&1 &")).toBe("regenerate");
    expect(selfInvocation("npx plainwright conformance app.plain 1")).toBe("conformance");
    expect(selfInvocation("node bin/plainwright.mjs skill skills/forge-plain")).toBe("skill");
    expect(selfInvocation("npm run module -- app.plain")).toBe("module");
    expect(selfInvocation("npx tsx src/render-frid.ts app.plain 1")).toBe("render");
    expect(selfInvocation('pi -p "build it"')).toBe("pi");
    expect(selfInvocation("plainwright chat -p 'render the module'")).toBe("chat");
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
    expect(selfInvocation("plainwright check app.plain")).toBeUndefined();
    expect(selfInvocation("plainwright doctor")).toBeUndefined();
    expect(selfInvocation("pip install requests")).toBeUndefined();
    expect(selfInvocation("python3 -m pytest")).toBeUndefined();
    expect(selfInvocation("grep -rn plainwright README.md")).toBeUndefined();
    expect(selfInvocation("cat plain_modules/app/code/render.py")).toBeUndefined();
    expect(selfInvocation("npm run test")).toBeUndefined();
  });

  it("is refused with the tool to use instead", () => {
    expect(refusal("module")).toContain("Use render_module instead.");
    expect(refusal("pi")).toContain("Do not start another agent");
  });
});

describe("whether the person asked for the command line", () => {
  it("is yes when they say so, or name the command", () => {
    expect(askedForCommandLine("run it headless overnight")).toBe(true);
    expect(askedForCommandLine("use the CLI for this")).toBe(true);
    expect(askedForCommandLine("run plainwright module app.plain in the terminal")).toBe(true);
    expect(askedForCommandLine("plainwright regenerate app.plain 3 please")).toBe(true);
  });

  it("is no for an ordinary request", () => {
    expect(askedForCommandLine("build the whole module")).toBe(false);
    expect(askedForCommandLine("render functionality 3 again")).toBe(false);
    expect(askedForCommandLine("regenerate the export")).toBe(false);
  });
});
