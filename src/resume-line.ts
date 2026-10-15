/** pi's line on the way out that says how to resume the session, with turri in place of pi as the command to run. */
export function resumeLine(text: string): string {
  return text.replace(/^((?:\x1b\[[0-9;]*m)*To resume this session:(?:\x1b\[[0-9;]*m)*\s+)pi(?= )/m, "$1turri");
}
