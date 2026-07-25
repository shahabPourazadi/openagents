# Admin panel

OpenAgents' admin UI lives at `/admin`. In open auth (`AUTH_MODE=none`), the default `dev-user` is treated as an active admin so you can exercise toggles locally without Supabase.

With `AUTH_MODE=supabase`, only profiles with `role = 'admin'` and `status = 'active'` can access admin routes. Promote admins via SQL / Studio (no in-app promotion):

```sql
update public.profiles
set role = 'admin', status = 'active'
where email in ('you@example.com');
```

## What you can manage

| Area | Purpose |
|------|---------|
| **Settings / signup** | When `FEATURE_SIGNUP_QUEUE=true`, choose Admin approve vs Auto approve; review pending users |
| **Models** | Base / Pro / Max OpenRouter tiers, enable/disable, ZDR-only |
| **Tool groups** | HITL, Firecrawl/MCP, document parse, deep builtins |
| **Agent sandbox** | Override `sandbox`, `execute`, concurrency, image — stored in `agent_runtime` |
| **Safety hooks** | Filesystem hooks, prompt injection, secret redaction, tool guard |
| **Company prompts & skills** | Draft → Publish org-level docs (optional; agents remain the primary specialization unit). Separate from the user **Skills** library / predefined agent skills — see [skills.md](skills.md). |
| **Users / budgets** | Approve/reject/disable (queue mode), per-user spend budget |
| **Audit** | Recent admin actions |

## Local open-auth tip

No signup queue is required for portfolio demos. Leave `FEATURE_SIGNUP_QUEUE=false` and use Admin mainly for model tiers and sandbox/tool toggles.

## Related

- [configuration.md](configuration.md) — `FEATURE_SIGNUP_QUEUE`, Resend, auth
- [sandbox.md](sandbox.md) — runtime overrides
