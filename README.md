# npm-deps-graph-cli

Visualize npm dependency graph as ASCII tree in the terminal.

## Installation

```bash
npm install -g npm-deps-graph-cli
```

## Usage

Run inside any npm project directory:

```bash
# Show full dependency tree (default depth: 3)
deps-graph

# Limit tree depth
deps-graph --depth 2

# Show only production dependencies
deps-graph --prod

# Show only dev dependencies
deps-graph --dev

# Flat list with versions
deps-graph --flat

# Highlight duplicate packages (different versions)
deps-graph --duplicates

# Find why a package is installed
deps-graph --why lodash

# JSON output
deps-graph --json

# Show stats summary
deps-graph --stats

# Combine flags
deps-graph --prod --depth 2 --stats
```

## Options

| Flag | Description |
|------|-------------|
| `--depth <n>` | Limit tree depth (default: 3) |
| `--prod` | Show only production dependencies |
| `--dev` | Show only devDependencies |
| `--flat` | Show flat list with versions |
| `--duplicates` | Highlight packages with multiple versions |
| `--why <pkg>` | Show reverse dependency chain for a package |
| `--json` | Output as JSON |
| `--stats` | Show total packages, max depth, duplicate count |

## License

MIT
