# ADR-0005 · TypeScript without a build step

**Decision.** Platform code is TypeScript executed directly by Node ≥ 22.18 type stripping
(`erasableSyntaxOnly`), type-checked by `tsc --noEmit` in CI. Runtime dependencies are limited to `pg`
and `zod`. No web framework: a ~200-line router keeps the attack surface and upgrade burden small.

**Consequences.** + Same "no toolchain" simplicity as the prototype, with types. − No enums, namespaces
or parameter properties; imports use `.ts` extensions. Revisit if the API grows beyond what a small
router handles comfortably (e.g. OpenAPI generation).
