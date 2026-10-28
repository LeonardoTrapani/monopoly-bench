import { defineConfig } from "vite-plus";

const agentDirs = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".pi/**",
  "tools/oxlint/anti-slop/**",
];

/** `@foldkit/oxlint-plugin` recommended rules, applied to `apps/web` only. */
const foldkitRules = {
  "foldkit/command-binding-matches-name": "error",
  "foldkit/command-define-pascal-const": "error",
  "foldkit/got-prefix-requires-submodel-payload": "error",
  "foldkit/got-submodel-message-name": "error",
  "foldkit/keyed-required-for-mapped-rows": "error",
  "foldkit/no-array-index-view-keys": "error",
  "foldkit/no-child-message-construction-in-root": "error",
  "foldkit/no-direct-submodel-state-update": "error",
  "foldkit/no-disabling-dev-guardrails": "error",
  "foldkit/no-empty-children-array": "error",
  "foldkit/no-empty-commands-array": "error",
  "foldkit/no-empty-object-tagged-call": "error",
  "foldkit/no-hand-rolled-command-struct": "error",
  "foldkit/no-hardcoded-route-strings": "error",
  "foldkit/no-impure-call-at-decision-time": "error",
  "foldkit/no-module-level-mutable-state": "error",
  "foldkit/no-noop-message": "error",
  "foldkit/no-raw-dom-event-attributes": "error",
  "foldkit/no-spread-in-modify-fields": "error",
  "foldkit/no-switch-on-message-tag": "error",
  "foldkit/prefer-callable-message-constructor": "error",
  "foldkit/prefer-command-mapmessage": "error",
  "foldkit/require-fold-for-child-update-result": "error",
  "foldkit/require-rel-for-external-link": "error",
  "foldkit/wrap-child-output-in-got-message": "error",
} as const;

export default defineConfig({
  lint: {
    ignorePatterns: [...agentDirs, "**/dist/**", "**/.alchemy/**", "**/.wrangler/**"],
    plugins: ["typescript", "oxc", "unicorn", "import"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
    overrides: [
      {
        // Foldkit's own rules for the web app (Elm-architecture conventions); not for the mock
        // API, which simulates a server, nor for tests.
        files: ["apps/web/src/**/*.ts"],
        excludeFiles: ["apps/web/src/mock/**", "apps/web/src/**/*.test.ts"],
        jsPlugins: [
          {
            name: "foldkit",
            specifier: "./apps/web/node_modules/@foldkit/oxlint-plugin/dist/index.js",
          },
        ],
        rules: foldkitRules,
      },
    ],
  },
  fmt: {
    ignorePatterns: [...agentDirs, "**/dist/**", "bun.lock"],
    semi: true,
    singleQuote: false,
    printWidth: 100,
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
