/**
 * `plainwright render` built one functionality. Nothing is built a functionality at a time now: the work is what is left
 * to build, planned into jobs - see docs/rendering.md.
 */
console.error(
  [
    "plainwright render is gone: the whole spec is built, what is left of it planned into jobs.",
    "- plainwright module <file.plain>              build it",
    "- plainwright module <file.plain> --dry-run    plan it, and print the prompt of the first job",
    "- plainwright regenerate <file.plain> <frid>   build one functionality again",
    "- plainwright conformance <file.plain> [frid]  write and run the conformance tests",
  ].join("\n"),
);
process.exit(1);
