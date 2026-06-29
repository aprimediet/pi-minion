# Changelog

## v1.1.0 (2026-06-29)

### Breaking change

- The bundled `todo_write` tool and `/todos` command have been extracted into
  `@aprimediet/todo`. To keep using `todo_write`, install `@aprimediet/todo`
  alongside minion:

  ```bash
  pi install npm:@aprimediet/todo
  ```

  minion v1.1.0+ now depends on `@aprimediet/todo` as a peer dependency.

### What's unchanged

- Subagent delegation (task board, agents, subagent tool)
- 12-agent library
- Everything else
