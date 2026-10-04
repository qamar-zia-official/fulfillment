import { config } from "@repo/eslint-config/base";

export default [
  ...config,
  {
    // `.trigger/` is generated build output from the Trigger.dev CLI (it currently holds
    // ~14MB of bundled worker code). It is gitignored and must never be linted, linted
    // or typechecked: doing so produced 1,289 warnings from machine-generated code and
    // would mask real findings in the hand-written task files.
    ignores: [".trigger/**"],
  },
];
