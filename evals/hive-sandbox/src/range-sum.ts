/** Sum of integers from `from` to `to`, inclusive on both ends. */
export function rangeSum(from: number, to: number): number {
  let total = 0;
  for (let n = from; n < to; n++) total += n;
  return total;
}
