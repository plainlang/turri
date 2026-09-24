# Theming

Two brand themes ship in `.pi/themes/`, built from the brand tokens. `plainwright chat` starts in
`forge`, the dark one; `--use-theme` picks another for that run:

```bash
plainwright chat                                  # forge
plainwright chat --use-theme forge-light/forge    # follows terminal appearance
plainwright chat --use-theme dark                 # pi's own
```

The second form follows your terminal's light/dark appearance. The default is for
`plainwright chat` only: pi's settings are left alone, so a plain `pi` keeps its theme. With the
themes installed globally (`plainwright setup` offers to), `{"theme": "forge"}` in
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

So `forge` (dark) carries yellow, green and green-light, and `forge-light` carries blue and
green-dark. **Brand blue never appears as text in the dark theme** - at 1.97:1 on brand black it is
illegible - so the dark theme's accent is brand yellow, and blue appears only in the light theme
and in both themes' HTML-export backgrounds.

Two values are not straight from the palette, and are named in the theme files so they are easy
to find:

- `avatarFlat` `#3a3d2e` - `--color-brand-avatar-bg` composited over brand black, because terminals
  have no alpha channel.
- `errorDark` `#2a1414` - the only invented colour. The palette has no dark red, and a failed tool
  row needs a background that `--color-brand-status-error` would overpower.

`--color-brand-status-warning` on white is 3.49:1, under the 4.5:1 bar for body text, so it is used
only for accents in the light theme, never for prose.

## Backgrounds

The dark theme paints no panels: every background token is brand black, so the terminal shows
through and the transcript reads as one surface. Two are deliberately not black, because they have
to be visible to work:

| token | value | why |
|---|---|---|
| `selectedBg` | `#223936` | a selection you cannot see is not a selection |
| `searchMatchBg` | `#e0ff6e` | search hits, with black text on top |

With tool rows carrying no background, their state is signalled by the title and the diff colours.

This only reaches as far as pi draws. **The window's own background is your terminal's setting** -
set it to `#0f0f0f` in your terminal profile, or the area around the transcript stays whatever it
was.

## The font

`--font-brand` cannot be applied. pi draws into a terminal, so the typeface is your terminal
emulator's setting, and NeueMontreal is proportional - a terminal needs a monospaced face. Set it
in iTerm2 / Ghostty / Alacritty, not here.
