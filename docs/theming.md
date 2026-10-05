# Theming

Two brand themes ship in `.pi/themes/`, built from the brand tokens. `turri chat` starts in
`turri-dark`, the dark one; `--use-theme` picks another for that run:

```bash
turri chat                                       # turri-dark
turri chat --use-theme turri-light/turri-dark    # follows terminal appearance
turri chat --use-theme dark                 # pi's own
```

The second form follows your terminal's light/dark appearance. The default is for
`turri chat` only: pi's settings are left alone, so a plain `pi` keeps its theme. With the
themes installed globally (`turri setup` offers to), `{"theme": "turri-dark"}` in
`~/.pi/agent/settings.json` gives a plain `pi` the same one.

Bad input fails quietly - an unknown `--use-theme` name and a malformed theme file both run without
complaint - so if the colours do not change, suspect a typo rather than the mechanism.

## Why there are two

Half the palette is unusable on the other background. Contrast against brand black and brand
white:

| token | on `#0f0f0f` | on `#ffffff` |
|---|---|---|
| brand-yellow | 17.07 | 1.12 |
| brand-green | 14.77 | 1.30 |
| brand-green-light | 13.34 | 1.44 |
| brand-blue | **1.97** | 9.72 |
| brand-green-dark | 1.56 | 12.31 |
| brand-red | 3.38 | 5.67 |

So `turri-dark` carries yellow, green and green-light, and `turri-light` carries blue and
green-dark. **Brand blue never appears as text in the dark theme** - at 1.97:1 on brand black it is
illegible - so the dark theme's accent is brand yellow, and blue appears only in the light theme
and in both themes' HTML-export backgrounds.

`--color-brand-status-warning` on white is 3.49:1, under the 4.5:1 bar for body text, so it is used
only for accents in the light theme, never for prose.

## Backgrounds

The dark theme paints no panels: the backgrounds of your messages, turri's messages and the
tool rows are `""`, the terminal's own background, so the transcript reads as one surface whatever
the terminal's colour is - brand black or not, no block shows up as a box. Two are deliberately
painted, because they have to be visible to work:

| token | value | why |
|---|---|---|
| `selectedBg` | `#223936` | a selection you cannot see is not a selection |
| `searchMatchBg` | `#e0ff6e` | search hits, with black text on top |

With tool rows carrying no background, their state is signalled by the title and the diff colours.

**The window's background is your terminal's setting**, and the transcript is drawn on it. For the
brand look, set it to brand black, `#0f0f0f`, in your terminal profile.

## Spec diffs

A spec diff in the panels is not painted with the theme's colours for code: those are made for code,
and the turri themes' backgrounds are all the surface colour, so a diff drawn with them would have no
fills and hardly any highlighting. It has a palette of its own (`src/grow/plain-palette.ts`), one for
a dark theme and one for a light, picked by the theme's appearance: a hue for each piece of \*\*\*plain -
a section's header, a concept, a link, text in quotes or backticks, a front matter key, a module,
a comment - at least 7:1 on the surface, and a fill behind each added and removed line, green and red,
that every colour still reads on.

## The font

`--font-brand` cannot be applied. pi draws into a terminal, so the typeface is your terminal
emulator's setting, and NeueMontreal is proportional - a terminal needs a monospaced face. Set it
in iTerm2 / Ghostty / Alacritty, not here.
