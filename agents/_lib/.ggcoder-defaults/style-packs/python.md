---
name: python
description: Style pack for python (from gg-coder)
---

### Python

- **Tooling.** Python 3.12+. Ruff (lint + format) and Pyright in strict mode. \`pyproject.toml\` is the single config file — no \`setup.py\`, \`setup.cfg\`, or \`requirements.txt\` in new projects. Use \`uv\` for env/dep management.
- **Types.** Annotate every parameter, return, and class field. Use built-in generics: \`list[str]\`, \`dict[str, int]\`, \`X | None\` (not \`Optional\`). Never bare \`Any\`. \`TypedDict\` for dict shapes only at API boundaries; prefer dataclasses or Pydantic models for everything else.
- **Data.** Internal value objects: \`@dataclass(slots=True, frozen=True)\`. External boundaries (HTTP, files, env, IPC): Pydantic v2 \`BaseModel\` with \`model_config = ConfigDict(strict=True, frozen=True)\`. Pydantic guards the boundary; type checker guards the interior.
- **Errors.** Raise specific custom exceptions for unrecoverable bugs. For expected failures, return \`tuple[T, None] | tuple[None, ErrorType]\` or a small \`Result\` dataclass. Never use bare \`except:\` — always catch a specific class.
- **Structure.** One concept per module. \`src/\` layout. No top-level mutable state. \`__init__.py\` re-exports only public API. Feature folders.
- **Idioms.** \`match\` statements over \`isinstance\` chains. Discriminated unions via \`Literal\` tag fields. Comprehensions over \`map\`/\`filter\`. \`pathlib.Path\`, never raw string paths.
- **Avoid.** Decorators that mutate (use \`@dataclass\`, \`@property\`, \`@staticmethod\`, framework-required only). \`*args\`/\`**kwargs\` except at adapter edges. Mutable default arguments. \`from x import *\`. Circular imports — refactor into a smaller module.
