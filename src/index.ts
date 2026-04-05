#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";

// ── Types ──────────────────────────────────────────────────────

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockPackage {
  version: string;
  resolved?: string;
  dependencies?: Record<string, string>;
  requires?: Record<string, string>;
}

interface LockfileV2 {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage & { dev?: boolean }>;
  dependencies?: Record<string, LockPackage & { dev?: boolean }>;
}

interface TreeNode {
  name: string;
  version: string;
  children: TreeNode[];
  isDuplicate?: boolean;
}

interface Stats {
  totalPackages: number;
  maxDepth: number;
  duplicateCount: number;
  duplicates: Record<string, string[]>;
}

interface CliOptions {
  depth: number;
  prod: boolean;
  dev: boolean;
  flat: boolean;
  duplicates: boolean;
  why?: string;
  json: boolean;
  stats: boolean;
}

// ── Depth-based colors ─────────────────────────────────────────

const depthColors = [
  chalk.cyan,
  chalk.green,
  chalk.yellow,
  chalk.magenta,
  chalk.blue,
  chalk.red,
  chalk.white,
];

function colorForDepth(depth: number): (text: string) => string {
  return depthColors[depth % depthColors.length]!;
}

// ── File loading ───────────────────────────────────────────────

function loadPackageJson(dir: string): PackageJson {
  const filePath = join(dir, "package.json");
  if (!existsSync(filePath)) {
    console.error(chalk.red("Error: package.json not found in " + dir));
    process.exit(1);
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function loadLockfile(dir: string): LockfileV2 | null {
  const lockPath = join(dir, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf-8"));
}

// ── Resolve version from lockfile ──────────────────────────────

function resolveVersion(
  lock: LockfileV2 | null,
  pkgName: string,
  specifier: string,
): string {
  if (!lock) return specifier;

  // lockfile v2/v3: packages field with "node_modules/..." keys
  if (lock.packages) {
    const key = "node_modules/" + pkgName;
    const entry = lock.packages[key];
    if (entry?.version) return entry.version;
  }

  // lockfile v1: dependencies field
  if (lock.dependencies) {
    const entry = lock.dependencies[pkgName];
    if (entry?.version) return entry.version;
  }

  return specifier;
}

// ── Get sub-dependencies from lockfile ─────────────────────────

function getSubDeps(
  lock: LockfileV2 | null,
  pkgName: string,
): Record<string, string> {
  if (!lock) return {};

  if (lock.packages) {
    const key = "node_modules/" + pkgName;
    const entry = lock.packages[key];
    return entry?.dependencies ?? {};
  }

  if (lock.dependencies) {
    const entry = lock.dependencies[pkgName];
    return entry?.requires ?? entry?.dependencies ?? {};
  }

  return {};
}

// ── Build tree ─────────────────────────────────────────────────

function buildTree(
  deps: Record<string, string>,
  lock: LockfileV2 | null,
  maxDepth: number,
  currentDepth: number = 0,
  visited: Set<string> = new Set(),
): TreeNode[] {
  if (currentDepth >= maxDepth) return [];

  const nodes: TreeNode[] = [];

  for (const [name, specifier] of Object.entries(deps)) {
    const version = resolveVersion(lock, name, specifier);
    const node: TreeNode = { name, version, children: [] };

    const key = `${name}@${version}`;
    if (!visited.has(key)) {
      visited.add(key);
      const subDeps = getSubDeps(lock, name);
      if (Object.keys(subDeps).length > 0) {
        node.children = buildTree(
          subDeps,
          lock,
          maxDepth,
          currentDepth + 1,
          new Set(visited),
        );
      }
    }

    nodes.push(node);
  }

  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Print ASCII tree ───────────────────────────────────────────

function printTree(
  nodes: TreeNode[],
  prefix: string = "",
  depth: number = 0,
  duplicateNames?: Set<string>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const color = colorForDepth(depth);

    let label = color(`${node.name}`) + chalk.dim(`@${node.version}`);
    if (duplicateNames?.has(node.name)) {
      label += chalk.red.bold(" [duplicate]");
    }

    console.log(prefix + connector + label);
    printTree(
      node.children,
      prefix + childPrefix,
      depth + 1,
      duplicateNames,
    );
  }
}

// ── Collect all packages ───────────────────────────────────────

function collectAll(
  nodes: TreeNode[],
  result: Map<string, Set<string>> = new Map(),
  depth: number = 0,
  maxDepthSeen: { value: number } = { value: 0 },
): { packages: Map<string, Set<string>>; maxDepth: number } {
  if (depth > maxDepthSeen.value) maxDepthSeen.value = depth;

  for (const node of nodes) {
    const versions = result.get(node.name) ?? new Set();
    versions.add(node.version);
    result.set(node.name, versions);
    collectAll(node.children, result, depth + 1, maxDepthSeen);
  }

  return { packages: result, maxDepth: maxDepthSeen.value };
}

// ── Find duplicates ────────────────────────────────────────────

function findDuplicates(
  packages: Map<string, Set<string>>,
): Record<string, string[]> {
  const dupes: Record<string, string[]> = {};
  for (const [name, versions] of packages) {
    if (versions.size > 1) {
      dupes[name] = [...versions].sort();
    }
  }
  return dupes;
}

// ── Compute stats ──────────────────────────────────────────────

function computeStats(tree: TreeNode[]): Stats {
  const { packages, maxDepth } = collectAll(tree);
  const duplicates = findDuplicates(packages);
  return {
    totalPackages: packages.size,
    maxDepth,
    duplicateCount: Object.keys(duplicates).length,
    duplicates,
  };
}

// ── Flat list ──────────────────────────────────────────────────

function printFlat(tree: TreeNode[]): void {
  const { packages } = collectAll(tree);
  const sorted = [...packages.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, versions] of sorted) {
    const versionStr = [...versions].join(", ");
    console.log(`  ${chalk.cyan(name)} ${chalk.dim(versionStr)}`);
  }
  console.log(chalk.dim(`\n  ${sorted.length} packages total`));
}

// ── Why command ────────────────────────────────────────────────

function findWhy(
  target: string,
  deps: Record<string, string>,
  lock: LockfileV2 | null,
  path: string[] = [],
  results: string[][] = [],
  visited: Set<string> = new Set(),
  maxSearchDepth: number = 10,
): string[][] {
  if (path.length > maxSearchDepth) return results;

  for (const [name, specifier] of Object.entries(deps)) {
    const version = resolveVersion(lock, name, specifier);
    const key = `${name}@${version}`;

    if (name === target) {
      results.push([...path, `${name}@${version}`]);
      continue;
    }

    if (visited.has(key)) continue;
    visited.add(key);

    const subDeps = getSubDeps(lock, name);
    if (Object.keys(subDeps).length > 0) {
      findWhy(
        target,
        subDeps,
        lock,
        [...path, `${name}@${version}`],
        results,
        new Set(visited),
        maxSearchDepth,
      );
    }
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────

const program = new Command();

program
  .name("deps-graph")
  .description("Visualize npm dependency graph as ASCII tree in the terminal")
  .version("1.0.0")
  .option("-d, --depth <number>", "limit tree depth", "3")
  .option("--prod", "show only production dependencies")
  .option("--dev", "show only devDependencies")
  .option("--flat", "show flat list with versions")
  .option("--duplicates", "highlight packages with multiple versions")
  .option("--why <package>", "show why a package is installed")
  .option("--json", "output as JSON")
  .option("--stats", "show total packages, max depth, duplicate count")
  .action((rawOpts) => {
    const opts: CliOptions = {
      depth: parseInt(rawOpts.depth, 10),
      prod: rawOpts.prod ?? false,
      dev: rawOpts.dev ?? false,
      flat: rawOpts.flat ?? false,
      duplicates: rawOpts.duplicates ?? false,
      why: rawOpts.why,
      json: rawOpts.json ?? false,
      stats: rawOpts.stats ?? false,
    };

    const cwd = resolve(".");
    const pkg = loadPackageJson(cwd);
    const lock = loadLockfile(cwd);

    // Determine which deps to include
    let deps: Record<string, string> = {};
    if (opts.prod && !opts.dev) {
      deps = pkg.dependencies ?? {};
    } else if (opts.dev && !opts.prod) {
      deps = pkg.devDependencies ?? {};
    } else {
      deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
    }

    if (Object.keys(deps).length === 0) {
      console.log(chalk.yellow("No dependencies found."));
      process.exit(0);
    }

    // --why mode
    if (opts.why) {
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      const chains = findWhy(opts.why, allDeps, lock);

      if (opts.json) {
        console.log(JSON.stringify({ package: opts.why, chains }, null, 2));
        return;
      }

      if (chains.length === 0) {
        console.log(
          chalk.yellow(`Package "${opts.why}" not found in dependency tree.`),
        );
        return;
      }

      console.log(
        chalk.bold(`\nWhy is ${chalk.cyan(opts.why)} installed?\n`),
      );
      for (const chain of chains) {
        const formatted = chain
          .map((entry, i) => {
            const color = colorForDepth(i);
            return color(entry);
          })
          .join(chalk.dim(" → "));
        console.log(`  ${chalk.bold(pkg.name)} → ${formatted}`);
      }
      console.log();
      return;
    }

    // Build tree
    const tree = buildTree(deps, lock, opts.depth);

    // --json mode
    if (opts.json) {
      const output: Record<string, unknown> = { tree };
      if (opts.stats) {
        output.stats = computeStats(tree);
      }
      if (opts.duplicates) {
        const { packages } = collectAll(tree);
        output.duplicates = findDuplicates(packages);
      }
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Header
    console.log(
      chalk.bold(`\n${pkg.name}`) + chalk.dim(`@${pkg.version}\n`),
    );

    // Determine duplicate names for highlighting
    let duplicateNames: Set<string> | undefined;
    if (opts.duplicates) {
      const { packages } = collectAll(tree);
      const dupes = findDuplicates(packages);
      duplicateNames = new Set(Object.keys(dupes));
    }

    // --flat mode
    if (opts.flat) {
      printFlat(tree);
    } else {
      printTree(tree, "", 0, duplicateNames);
    }

    // --duplicates summary
    if (opts.duplicates) {
      const { packages } = collectAll(tree);
      const dupes = findDuplicates(packages);
      const dupeEntries = Object.entries(dupes);
      if (dupeEntries.length > 0) {
        console.log(
          chalk.bold.red(`\n  Duplicates (${dupeEntries.length}):\n`),
        );
        for (const [name, versions] of dupeEntries) {
          console.log(
            `    ${chalk.red(name)}: ${chalk.dim(versions.join(", "))}`,
          );
        }
      } else {
        console.log(chalk.green("\n  No duplicate packages found."));
      }
    }

    // --stats mode
    if (opts.stats) {
      const stats = computeStats(tree);
      console.log(chalk.bold("\n  Stats:\n"));
      console.log(
        `    Total packages:  ${chalk.cyan(String(stats.totalPackages))}`,
      );
      console.log(
        `    Max depth:       ${chalk.cyan(String(stats.maxDepth))}`,
      );
      console.log(
        `    Duplicates:      ${stats.duplicateCount > 0 ? chalk.red(String(stats.duplicateCount)) : chalk.green("0")}`,
      );
    }

    console.log();
  });

program.parse();
