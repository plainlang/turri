import { compositeTuiLine } from "@earendil-works/pi-tui";

/** What the banner puts between a row's text and the picture after it: back to the jellyfish's column. */
export const PICTURE_AT = "\x1b[2G";

/** The picture's escape sequence, as the banner writes it after PICTURE_AT: Kitty's, in chunks, or iTerm2's - climbing first on iTerm2. */
const PICTURE = /^(?:\x1b\[\d+A)?(?:(?:\x1b_G[^\x1b]*\x1b\\)+|\x1b\]1337;File=[^\x07]*\x07)/;

/**
 * The banner's picture row with an overlay drawn over its text, the picture after it - left out while the overlay
 * reaches over the picture, `pictureRight` columns from the left edge. Undefined for a row that holds no picture.
 *
 * What follows the picture - the padding a row narrower than the screen is given, the chat's beside the docked panel -
 * is the row's text: written after the picture, from the picture's column, it would blank the row.
 */
export function overPictureRow(base: string, overlay: string, col: number, width: number, total: number, pictureRight: number): string | undefined {
  const at = base.lastIndexOf(PICTURE_AT);
  const picture = at === -1 ? null : PICTURE.exec(base.slice(at + PICTURE_AT.length));
  if (picture === null) return undefined;
  const after = base.slice(at + PICTURE_AT.length + picture[0].length);
  const drawn = compositeTuiLine(`${base.slice(0, at)}${after}`, overlay, col, width, total);
  return col >= pictureRight ? `${drawn}${PICTURE_AT}${picture[0]}` : drawn;
}
