import { describe, expect, it } from "vitest";
import { failureSignature } from "../../src/regenerate/conformance.ts";

const run = (output: string) => ({ command: "run_conformance_tests_python.sh", exitCode: 1, output });
const rejected = (correlation: string) =>
  `\x1B[1m\x1B[31mE           RuntimeError: GET https://api.hubapi.com/crm/objects/2026-09/contacts returned status 401: ` +
  `{"status":"error","message":"Authentication credentials not found.","correlationId":"${correlation}","category":"INVALID_AUTHENTICATION"}\x1B[0m\n` +
  "FAILED tests/test_conformance_functionality_2.py::test_live_client - RuntimeError\n";

describe("a failing run's fingerprint", () => {
  it("is the same for two runs that differ only in the ids a service makes up for each response", () => {
    expect(failureSignature(run(rejected("01a0f6b9-409c-7010-86de-bb0f7a81bf6d")))).toBe(
      failureSignature(run(rejected("01a0f6af-3ced-7140-ae0d-546b859492c7"))),
    );
    expect(failureSignature(run("Error: request 9f3ab2 failed\n"))).toBe(failureSignature(run("Error: request c41d07 failed\n")));
  });

  it("still tells apart two runs that fail differently", () => {
    expect(failureSignature(run(rejected("01a0f6b9-409c-7010-86de-bb0f7a81bf6d")))).not.toBe(
      failureSignature(run("FAILED tests/test_conformance_functionality_3.py::test_mapping - AssertionError: full_name\n")),
    );
    expect(failureSignature(run("FAILED test_conformance_functionality_1.py - AssertionError\n"))).not.toBe(
      failureSignature(run("FAILED test_acceptance_functionality_1.py - AssertionError\n")),
    );
  });
});
