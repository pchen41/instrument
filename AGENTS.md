PRD is in docs folder. 
Tasks are in tasks folder. Each task is it's own separate document (e.g. task-1.md, task-2.md, etc.).
Tasks should be a reasonable-sized self-contained unit of work that is testable, both in an automated and manual way. Remember to write tests.
Task files contain requirements, acceptance criteria and are modified to include any progress or notes.
Design mockups are in design folder (read README.md in that folder).
All of the above documents are meant to be read by AI to provide context, so any modifications should be appropriate for that purpose.
Remember to commit regularly (probably after every task, but maybe multiple times per task if appropriate).

How to headlessly invoke other agents:

claude:
env -u CLAUDECODE claude -p "prompt" --dangerously-skip-permissions

Unset CLAUDECODE so the subprocess does not treat itself as a nested Claude Code session.

codex:
codex exec --full-auto --skip-git-repo-check "prompt"

gemini:
agy -p "prompt"

When working on a task, get feedback when deciding on approach from claude, codex and gemini and also get code reviewed by them after finishing implementation. You can ignore feedback if you disagree with it. Ask the user when you're not sure.