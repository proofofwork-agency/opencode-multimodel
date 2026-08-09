export async function mapLimit<Input, Output>(
  items: Input[],
  concurrency: number,
  run: (item: Input, index: number) => Promise<Output>,
) {
  const output: Output[] = [];
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        output[index] = await run(items[index]!, index);
      }
    },
  );
  await Promise.all(lanes);
  return output;
}
