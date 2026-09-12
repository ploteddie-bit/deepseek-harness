# @deepseek-ai/dsh-llm-deepseek-pmu

A second DeepSeek chat-completions adapter route (`deep-pmu`) for the DeepSeek
Harness LLM seam. It reuses the official `DeepSeekAdapter` and its resolution
logic from `@deepseek-ai/dsh-llm-deepseek`, but owns a distinct provider route
and its own API key, so `deep-pmu` and `deepseek-official` appear side by
side in the Models page as two independent entries.

- Provider route: `deep-pmu`
- Display name: `DeepSeek PMU`
- Settings namespace: `llm-deepseek-pmu`
- API key: read per request from `DEEPSEEK_PMU_API_KEY` (or the credential seam)

The plugin inlines no secret and does not modify `llm-deepseek`. To use it,
export the key in the launching environment:

```sh
export DEEPSEEK_PMU_API_KEY=sk-...
```

Then select the `deep-pmu` provider in the Models page or from the picker.
