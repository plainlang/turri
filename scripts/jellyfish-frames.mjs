#!/usr/bin/env node
// The banner's text jellyfish, frame by frame, for terminals that show no images: written to
// assets/jellyfish/fallback.txt, the frames one after another, each ended by a line of "---".
//
// One stroke drives it all, as a jellyfish swims: the bell snaps shut - narrower, taller - and the
// jellyfish rises a row; the tentacles, rooted on the rim, are drawn in with it and straighten, the
// pull running down them a little after; then the bell opens slowly, and they fan out again and
// curl, from the top down. Their tips are where it comes apart into code, as regenerative software
// grows the code again from the spec.
//
//   node scripts/jellyfish-frames.mjs          write the frames
//   node scripts/jellyfish-frames.mjs --play   play them here, at the banner's speed
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRAME_MS = 250;
/** The column the jellyfish is centred on. */
const CENTRE = 14.5;

/**
 * How shut the bell is, frame by frame - a frame a quarter second: shut quickly, through half shut,
 * held a moment, then opened slowly, through half shut again, and at rest until the next stroke.
 */
const SHUT = [0.15, 0.5, 0.85, 1, 0.92, 0.82, 0.72, 0.62, 0.52, 0.44, 0.37, 0.3, 0.24, 0.18, 0.13, 0.09, 0.06, 0.1];
const FRAMES = SHUT.length;

/** The bell open, half shut and shut: each narrower than the last, centred, its rim last. */
const BELLS = [
  ["▄▄▆▆██▆▆▄▄", "▄▆█▓▒░░░░░░▒▓█▆▄", "▄█▓▒░  ░▒▒▒▒░  ░▒▓█▄", "▐█▒░  ░▒▓████▓▒░  ░▒█▌", `▝█${"▄".repeat(18)}█▘`],
  ["▄▆▆██▆▆▄", "▄▆█▓▒░░░░▒▓█▆▄", "▄█▓▒░ ░▒▒▒▒░ ░▒▓█▄", "▐█▒░ ░▒▓████▓▒░ ░▒█▌", `▝█${"▄".repeat(16)}█▘`],
  ["▄▆██▆▄", "▄▆█▓▒░░▒▓█▆▄", "▄█▓▒░░▒▓▓▒░░▒▓█▄", "▐█▒░░▒▓████▓▒░░▒█▌", `▝█${"▄".repeat(14)}█▘`],
];
const bellOf = (shut) => (shut > 0.7 ? 2 : shut > 0.35 ? 1 : 0);

const TENTACLE_ROWS = 7;
const ROWS = 1 + BELLS[0].length + TENTACLE_ROWS;
const WIDTH = 30;
/** The strands: where on the rim each hangs, from -1 (its left end) to 1 (its right), and how long. The two in the middle are the thick oral arms. */
const STRANDS = [
  { at: -0.85, len: 7 },
  { at: -0.58, len: 6 },
  { at: -0.3, len: 7 },
  { at: -0.06, len: 6, arm: true },
  { at: 0.06, len: 5, arm: true },
  { at: 0.3, len: 7 },
  { at: 0.58, len: 6 },
  { at: 0.85, len: 7 },
];
const CODE = ["#", "$", "%", ";", "@", "&", "*", "."];

function frame(t) {
  const grid = Array.from({ length: ROWS }, () => Array(WIDTH).fill(" "));
  const put = (y, x, ch) => {
    if (y >= 0 && y < ROWS && x >= 0 && x < WIDTH && grid[y][x] === " ") grid[y][x] = ch;
  };
  // Shut, it has risen a row.
  const top = SHUT[t] > 0.7 ? 0 : 1;
  const bell = BELLS[bellOf(SHUT[t])];
  bell.forEach((line, y) => {
    const left = Math.round(CENTRE - (line.length - 1) / 2);
    [...line].forEach((ch, x) => ch !== " " && (grid[top + y][left + x] = ch));
  });
  const rimHalf = (bell.at(-1).length - 2) / 2;
  const rimRow = top + bell.length;
  STRANDS.forEach((strand, i) => {
    // Each row of a strand moves as the bell did a moment before - the further down, the later.
    const shutAt = (y) => SHUT[(t - Math.floor(y / 2) + FRAMES * 2) % FRAMES];
    const at = (y) => {
      const shut = shutAt(y);
      // Rooted on the rim, drawn in as it narrows; down and to the left; curling as the bell opens, straight as it shuts.
      const root = CENTRE + strand.at * rimHalf;
      const curl = (1 - shut) * 1.1 * Math.sin(0.95 * y + i * 0.5 + 0.6);
      return root - 0.9 * y * (1 - 0.25 * shut) + curl;
    };
    for (let y = 0; y < strand.len; y++) {
      const x = Math.round(at(y));
      if (y === strand.len - 1) put(rimRow + y, x, CODE[i % CODE.length]);
      else if (y === strand.len - 2) put(rimRow + y, x, "⁏");
      else if (strand.arm && y === 0) put(rimRow + y, x, "║");
      else {
        // The way it goes on from here: on out to the left, straight down, or back under itself.
        const next = Math.round(at(y + 1)) - x;
        put(rimRow + y, x, next <= -2 ? "╱" : next >= 0 ? ")" : y % 2 === 0 ? ")" : "(");
      }
    }
  });
  return grid.map((row) => row.join("").replace(/\s+$/, ""));
}

const frames = Array.from({ length: FRAMES }, (_, t) => frame(t));

if (process.argv.includes("--play")) {
  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", () => (process.stdout.write("\x1b[?25h\n"), process.exit(0)));
  let t = 0;
  process.stdout.write("\n".repeat(ROWS));
  setInterval(() => {
    process.stdout.write(`\x1b[${ROWS}A${frames[t % FRAMES].map((line) => `\x1b[2K${line}`).join("\n")}\n`);
    t += 1;
  }, FRAME_MS);
} else if (process.argv.includes("--sheet")) {
  for (let band = 0; band < FRAMES; band += 5) {
    const shown = frames.slice(band, band + 5);
    console.log(shown.map((_, k) => `frame ${band + k}`.padEnd(WIDTH)).join(""));
    for (let y = 0; y < ROWS; y++) console.log(shown.map((f) => (f[y] ?? "").padEnd(WIDTH)).join(""));
    console.log();
  }
} else {
  const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets", "jellyfish", "fallback.txt");
  writeFileSync(out, frames.map((lines) => `${lines.join("\n")}\n---\n`).join(""));
  console.log(`wrote ${FRAMES} frames to ${out}`);
}
