import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

type DependencySection = Record<string, string>

interface PackageManifest {
  name?: string
  dependencies?: DependencySection
  devDependencies?: DependencySection
  optionalDependencies?: DependencySection
  peerDependencies?: DependencySection
}

interface AlignedCohort {
  name: string
  packages: string[]
  reason: string
}

interface ResolvedSingleton {
  package: string
  minimumVersion?: string
  reason: string
}

interface DependencyPolicy {
  schemaVersion: number
  alignedDirectVersionCohorts: AlignedCohort[]
  resolvedSingletons: ResolvedSingleton[]
}

interface ResolvedNode {
  version?: string
  dependencies?: Record<string, ResolvedNode>
  devDependencies?: Record<string, ResolvedNode>
  optionalDependencies?: Record<string, ResolvedNode>
}

const root = process.cwd()
const policy = JSON.parse(
  readFileSync(join(root, ".github/dependency-policy.json"), "utf8"),
) as DependencyPolicy

if (policy.schemaVersion !== 1) {
  throw new Error(
    `Unsupported dependency policy schema: ${policy.schemaVersion}`,
  )
}

const manifestPaths = ["package.json"]
for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(join(root, parent), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) {
      manifestPaths.push(join(parent, entry.name, "package.json"))
    }
  }
}

const directVersions = new Map<
  string,
  Array<{ manifest: string; version: string }>
>()
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(
    readFileSync(join(root, manifestPath), "utf8"),
  ) as PackageManifest
  for (const section of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [name, version] of Object.entries(section ?? {})) {
      const declarations = directVersions.get(name) ?? []
      declarations.push({ manifest: manifestPath, version })
      directVersions.set(name, declarations)
    }
  }
}

const errors: string[] = []
for (const cohort of policy.alignedDirectVersionCohorts) {
  const declarations = cohort.packages.flatMap((name) =>
    (directVersions.get(name) ?? []).map((entry) => ({ ...entry, name })),
  )
  const normalizedVersions = new Set(
    declarations.map(({ version }) => normalizeDeclaredVersion(version)),
  )
  if (declarations.length === 0) {
    errors.push(`${cohort.name}: no configured package is declared.`)
    continue
  }
  if (normalizedVersions.size > 1) {
    const details = declarations
      .map(({ manifest, name, version }) => `${manifest}:${name}@${version}`)
      .join(", ")
    errors.push(`${cohort.name} is not aligned (${details}). ${cohort.reason}`)
  }
}

const singletonNames = policy.resolvedSingletons.map(
  ({ package: name }) => name,
)
const listOutput = execFileSync(
  "pnpm",
  ["list", ...singletonNames, "--recursive", "--depth", "Infinity", "--json"],
  { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
)
const resolvedRoots = JSON.parse(listOutput) as ResolvedNode[]
const resolvedVersions = new Map(
  singletonNames.map((name) => [name, new Set<string>()]),
)

function visit(node: ResolvedNode): void {
  for (const section of [
    node.dependencies,
    node.devDependencies,
    node.optionalDependencies,
  ]) {
    for (const [name, child] of Object.entries(section ?? {})) {
      if (resolvedVersions.has(name) && child.version) {
        resolvedVersions.get(name)?.add(child.version)
      }
      visit(child)
    }
  }
}

for (const resolvedRoot of resolvedRoots) {
  visit(resolvedRoot)
}

for (const singleton of policy.resolvedSingletons) {
  const versions = resolvedVersions.get(singleton.package) ?? new Set<string>()
  if (versions.size === 0) {
    errors.push(
      `${singleton.package}: package is configured but was not resolved.`,
    )
  } else if (versions.size > 1) {
    errors.push(
      `${singleton.package} resolved to ${[...versions].sort().join(", ")}. ${singleton.reason}`,
    )
  }
  if (singleton.minimumVersion) {
    const minimum = parseVersion(singleton.minimumVersion)
    for (const version of versions) {
      const resolved = parseVersion(version)
      if (minimum && resolved && compareVersions(resolved, minimum) < 0) {
        errors.push(
          `${singleton.package} resolved to ${version}, below the security floor ` +
            `${singleton.minimumVersion}. ${singleton.reason}`,
        )
      }
    }
  }
}

const overrides = readWorkspaceOverrides(
  readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
)
for (const [name, overrideVersion] of overrides) {
  for (const declaration of directVersions.get(name) ?? []) {
    if (!declaredRangeContains(declaration.version, overrideVersion)) {
      errors.push(
        `${name} is declared as ${declaration.version} in ${declaration.manifest} but ` +
          `pnpm overrides it to ${overrideVersion}; the advertised update would not be tested.`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error("Dependency compatibility policy failed:\n")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Dependency compatibility policy passed (${policy.alignedDirectVersionCohorts.length} ` +
    `declared cohorts, ${policy.resolvedSingletons.length} resolved singletons).`,
)

function normalizeDeclaredVersion(version: string): string {
  const match = version.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match?.[0] ?? version
}

function readWorkspaceOverrides(yaml: string): Map<string, string> {
  const overrides = new Map<string, string>()
  let inOverrides = false
  for (const line of yaml.split("\n")) {
    if (line === "overrides:") {
      inOverrides = true
      continue
    }
    if (inOverrides && line.length > 0 && !line.startsWith(" ")) break
    if (!inOverrides) continue
    const match = line.match(
      /^ {2}(?:"([^"]+)"|([^:]+)):\s*["']?([^"'#\s]+)["']?/,
    )
    if (match) overrides.set((match[1] ?? match[2]).trim(), match[3])
  }
  return overrides
}

function declaredRangeContains(
  declared: string,
  overrideVersion: string,
): boolean {
  const declaredVersion = parseVersion(normalizeDeclaredVersion(declared))
  const override = parseVersion(overrideVersion)
  if (!declaredVersion || !override) return true
  const comparison = compareVersions(override, declaredVersion)
  if (declared.startsWith("^")) {
    return comparison >= 0 && override[0] === declaredVersion[0]
  }
  if (declared.startsWith("~")) {
    return (
      comparison >= 0 &&
      override[0] === declaredVersion[0] &&
      override[1] === declaredVersion[1]
    )
  }
  return comparison === 0
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}
