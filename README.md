Instrument is an AI SRE agent that proactively suggests improvments to observatibility and also helps with root cause diagnosis during incidents. 
It does this by pulling data from multiple sources (DataDog, TrueFoundry, Github) for the maximum accuracy.

Instrument does this by:
- Reviewing PRs for logging/metric improvements
- Scanning the codebase to find gaps in logging/metrics (and generating PRs to address gaps)
- Recommending new DataDog monitors (and generating draft monitors in DataDog)
- Receiving DataDog alerts and automatically starting root cause investigations (by pulling data from the above sources)

Instrument is also designed to be resilient (e.g. to API/MCP failures, job failures) and uses/implements:
- Durable job system, including automated scan to handle orphan and failed jobs (e.g. for RCA investigation or PR generation).
- TrueFoundry virtual model which allows automatic fallback from one LLM provider to another.
- TrueFoundry input/output guardrails to prevent prompt injection and filter secrets/PII from output
- TrueFoundry MCP gateway to limit agents to least privileges (e.g. investigation agent only has access to read-only MCP tools)

Made for TrueFoundy Resilient Agents hackathon (demo video: https://www.youtube.com/watch?v=NBP6Ur52lH4).
