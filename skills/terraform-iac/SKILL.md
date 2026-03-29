---
name: terraform-iac
category: infrastructure
description: Terraform IaC patterns — module structure, state management, GitHub provider, and GitWeave-style org control.
---

## When to Use This Skill

- When working on GitWeave or any Terraform-managed infrastructure
- When designing module structure for GitHub org configuration
- When managing state, providers, or variable injection
- When writing Terraform for cloud resources (see Cost Policy below)

## Module Structure (GitWeave Pattern)

```
terraform/
├── main.tf              # Root module — provider config, module calls
├── variables.tf         # Input variables with descriptions and validation
├── outputs.tf           # Exported values for other modules/consumers
├── versions.tf          # Required providers and Terraform version constraint
├── terraform.tfvars     # ← GITIGNORED — actual values
├── terraform.tfvars.example  # ← Checked in — masked template
├── modules/
│   ├── github-repos/    # Repository configuration
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── github-teams/    # Team membership and permissions
│   └── github-branch-protection/  # Branch protection rules
└── environments/
    ├── prod/            # Production org config
    │   ├── main.tf      # Calls modules with prod values
    │   └── backend.tf   # Remote state config
    └── staging/
```

## GitHub Provider

```hcl
terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = var.github_org
  token = var.github_token  # From TF_VAR_github_token env var
}
```

## Variable Patterns

```hcl
# variables.tf
variable "github_token" {
  type        = string
  sensitive   = true
  description = "GitHub PAT with admin:org scope"
}

variable "github_org" {
  type        = string
  description = "GitHub organization name"
  validation {
    condition     = can(regex("^[a-zA-Z0-9-]+$", var.github_org))
    error_message = "Organization name must be alphanumeric with hyphens."
  }
}

variable "repos" {
  type = map(object({
    description     = string
    visibility      = optional(string, "private")
    default_branch  = optional(string, "main")
    topics          = optional(list(string), [])
    has_issues      = optional(bool, true)
    has_wiki        = optional(bool, false)
    template        = optional(string, null)
  }))
  description = "Map of repository configurations"
}
```

## tfvars Template (Mask Secrets)

```hcl
# terraform.tfvars.example — copy to terraform.tfvars and fill in values
github_org   = "your-org-name"
github_token = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

repos = {
  "example-repo" = {
    description = "Example repository"
    visibility  = "private"
    topics      = ["example"]
  }
}
```

## State Management

**Local state only** — no paid remote backends (S3, GCS, Terraform Cloud) until explicitly changed.

```hcl
# No backend block needed — Terraform defaults to local state.
# State files live in the working directory as terraform.tfstate.
```

Ensure `.terraform/` and `*.tfstate*` are gitignored. Local state is the right choice for solo/personal projects — remote backends add cost and complexity that isn't justified yet.

When the decision to move to remote state is made, options include S3+DynamoDB, GCS, or Terraform Cloud — but that's a future decision, not a default.

## Resource Patterns

### Repository with Branch Protection

```hcl
resource "github_repository" "repo" {
  for_each = var.repos

  name        = each.key
  description = each.value.description
  visibility  = each.value.visibility
  has_issues  = each.value.has_issues

  # Prevent accidental deletion
  archive_on_destroy = true
}

resource "github_branch_protection" "main" {
  for_each = var.repos

  repository_id = github_repository.repo[each.key].node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 1
    dismiss_stale_reviews           = true
  }

  required_status_checks {
    strict   = true
    contexts = ["ci/build", "ci/test"]
  }

  enforce_admins = false  # Allow admin bypass for automation
}
```

## CLI Workflow

```bash
# Initialize (downloads providers)
terraform init

# Validate config syntax
terraform validate

# Preview changes
terraform plan -out=tfplan

# Apply (always from a saved plan)
terraform apply tfplan

# Import existing resources
terraform import 'github_repository.repo["existing-repo"]' existing-repo

# State inspection
terraform state list
terraform state show 'github_repository.repo["my-repo"]'
```

## Cost Policy

### Allowed (agents can use freely)
- **Free services**: Cloudflare free tier, Terraform Registry, GitHub Actions, etc.
- **Existing subscriptions**: GitHub (current plan) — manage repos, teams, branch protection via IaC
- **Local-first infrastructure**: devcontainers, minikube, Docker Compose, LocalStack, etc.

### Restricted (never by agents autonomously)
- **Paid cloud compute**: EC2, GCE, Azure VMs, Lambda, Cloud Run, etc. — strong preference for local alternatives
- **Subscription/budget changes**: billing settings, plan upgrades, spending limits — must be human-controlled, never agent-applied (may appear in IaC for documentation but `terraform apply` on these resources requires explicit human approval)
- **Paid storage/databases**: RDS, Cloud SQL, managed Redis, etc.

### Testing cloud-hosted patterns
When a project needs to validate how it would run in the cloud, prefer:
1. **LocalStack** for AWS service emulation
2. **minikube / kind** for Kubernetes
3. **devcontainers** for reproducible dev environments
4. **Docker Compose** for multi-service stacks
5. **Mocked providers** (`terraform plan` without `apply`) for IaC validation

Only provision real paid cloud resources when explicitly approved and with clear cost bounds.

## Security Checklist

- [ ] No secrets in `.tf` files (use `TF_VAR_*` env vars or `.tfvars`)
- [ ] `terraform.tfvars` and `*.tfstate*` are gitignored
- [ ] Sensitive variables marked with `sensitive = true`
- [ ] State files gitignored (local state — no paid remote backends)
- [ ] Provider versions pinned (`~>` not `>=`)
- [ ] `archive_on_destroy = true` on critical resources
