---
name: php
description: Style pack for php (from gg-coder)
---

### PHP

- **Tooling.** PHP 8.3+. PHPStan or Psalm at max level. \`php-cs-fixer\` or \`pint\`. Composer with strict autoload.
- **Types.** \`declare(strict_types=1);\` at the top of every file. Type every parameter, return, and property. \`readonly\` classes and properties everywhere possible. Enums (backed) for closed sets — never string constants.
- **Data.** Constructor property promotion for DTOs: \`public function __construct(public readonly string $name, public readonly int $age) {}\`. Final classes by default.
- **Errors.** Typed custom exceptions per domain. For expected failures, return a small \`Result\` value object or use a discriminated union of result classes. Never catch \`\\\\Throwable\` except at the request boundary.
- **Structure.** PSR-4 autoloading. Package by feature. No global state. Constructor injection only.
- **Avoid.** Untyped parameters or returns. \`@\` error suppression. Globals. Static mutable state. Multiple inheritance via traits as a workaround for poor design. \`extract()\`, \`compact()\`, variable variables.
