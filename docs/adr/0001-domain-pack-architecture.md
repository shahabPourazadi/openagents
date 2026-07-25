# Agent architecture over hardcoded domain

The original product hardcoded an invention-disclosure workflow into prompts, tools, and document parsing. OpenAgents makes the core domain-agnostic: an Agent (prompt + soul + skills + optional document template + optional `tools.py`) is the unit of specialization. This is harder to reverse than a single default prompt, but it is the product — without agents there is nothing to open-source that differentiates from a chat UI.
