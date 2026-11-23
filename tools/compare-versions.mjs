// SemVer precedence comparison, shared by the sync and validation scripts.
//
// A local implementation keeps the tooling dependency-free: the only package this
// repository installs is the DSH market parser it validates against.

/**
 * Compare two SemVer strings by precedence.
 * @returns a negative number when `left` sorts lower, a positive number when it sorts
 *   higher, and zero when the two have equal precedence.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const withoutBuild = value.split('+')[0];
    const dash = withoutBuild.indexOf('-');
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);
    return {
      numbers: core.split('.').map(Number),
      pre: prerelease === '' ? [] : prerelease.split('.'),
      hasPre: prerelease !== '',
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.hasPre !== b.hasPre) return a.hasPre ? -1 : 1;
  if (!a.hasPre) return 0;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/u.test(x);
    const numericY = /^\d+$/u.test(y);
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (numericX !== numericY) {
      return numericX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
