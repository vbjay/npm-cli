# Agents

## indicator-tuner

Specialist agent for improving the build-indicator registry and deep-scan pipeline.
Drives `uncategorized` and `gaps` counts in `indicator-suggestions.json` to zero by
analyzing embedded `$ai` tasks, tuning `commandPatterns`, and improving signal coverage.

Full instructions: [`.github/agents/indicator-tuner.agent.md`](.github/agents/indicator-tuner.agent.md)
