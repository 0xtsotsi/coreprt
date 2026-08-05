---
name: terraform
description: Style pack for terraform (from gg-coder)
---

### Terraform / HCL

- **Tooling.** Latest stable Terraform or OpenTofu. \`terraform fmt\`. \`tflint\` + \`tfsec\` (or \`checkov\`) in CI. Pinned provider versions in \`required_providers\`. Remote state with locking always.
- **Structure.** Modules by infrastructure concern (\`network/\`, \`compute/\`, \`data/\`). \`main.tf\`, \`variables.tf\`, \`outputs.tf\`, \`versions.tf\` per module. No monolithic root module — environments compose modules.
- **Variables.** Every variable has a \`type\` and a \`description\`. \`sensitive = true\` on secrets. Validate with \`validation\` blocks. No untyped \`any\` variables.
- **State.** One state file per environment + concern. Never commit \`.tfstate\` or \`.tfvars\` with secrets to git. Use \`tfvars\` files per environment, kept out of public repos.
- **Resources.** Explicit \`tags\` blocks on every resource that supports them. Lifecycle \`prevent_destroy = true\` on stateful infrastructure (databases, buckets) unless intentionally ephemeral.
- **Avoid.** \`count\` for set-like collections — use \`for_each\` with a map. Hard-coded provider regions or account IDs (use variables). Implicit dependencies — declare \`depends_on\` when ordering matters. \`local-exec\` provisioners as a primary tool (use them only as a last resort).
