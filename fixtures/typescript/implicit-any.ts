// Negative fixture: `input` has an implicit `any` type, so compiling this file
// under the workspace tsconfig must fail with TS7006. Verified by `pnpm gates:check`.
export function echo(input) {
  return input;
}
