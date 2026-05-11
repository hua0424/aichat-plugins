## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current

## Git Submodules

- `teamdocs/` is a git submodule pointing to `https://github.com/hua0424/aichat-hula-docs.git`
- When committing changes that include teamdocs/, use `git submodule update --init --recursive` after clone
- To update teamdocs to latest: `git submodule update --remote teamdocs` then commit the updated submodule ref
- Do not directly commit files inside teamdocs/ from this repo — go into teamdocs/ and commit from there
