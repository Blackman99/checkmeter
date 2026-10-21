export interface Paint { on: boolean; flag(s: string): string; review(s: string): string; ok(s: string): string; dim(s: string): string; bold(s: string): string; head(s: string): string; lilac(s: string): string }
export function paint(on: boolean): Paint {
  const w = (open: string, close = '\x1b[0m') => (s: string) => (on ? `${open}${s}${close}` : s);
  return {
    on,
    flag: w('\x1b[38;5;203m'), // coral
    review: w('\x1b[38;5;215m'), // amber
    ok: w('\x1b[38;5;121m'), // mint
    lilac: w('\x1b[38;5;183m'),
    dim: w('\x1b[2m', '\x1b[22m'),
    bold: w('\x1b[1m', '\x1b[22m'),
    head: w('\x1b[1;38;5;152m'),
  };
}
export function colorWanted(flag: boolean | undefined, stream: NodeJS.WriteStream): boolean {
  if (flag === false) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!stream.isTTY;
}
// visible width (strip ANSI)
export const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
export const padEnd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - vis(s)));
export const padStart = (s: string, n: number) => ' '.repeat(Math.max(0, n - vis(s))) + s;
