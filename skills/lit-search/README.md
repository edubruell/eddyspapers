# lit-search

A Claude Code skill for Eddy's Papers, the semantic search engine over the RePEc economics
literature.

## Install

Unzip the folder into your skills directory:

- for every project: `~/.claude/skills/lit-search/`
- for one project only: `.claude/skills/lit-search/` inside that project

Then start Claude Code and type `/lit-search`.

## You need a key

The skill talks to the eddysearch MCP server, which needs an API key. Ask for one at
https://econpapers.eduard-bruell.de/mcp and it arrives by email. Register the server with:

    claude mcp add --scope user --transport http eddysearch \
      https://agenticsearch.eduard-bruell.de/mcp --header "Authorization: Bearer YOUR_KEY"

## Where it writes

On its first run in a project the skill asks where literature output should be stored, and
remembers the answer in `.eddysearch.json` at the project root. Move the directory, or edit
that file, and it follows.

Questions and bug reports: eduard.bruell@zew.de
