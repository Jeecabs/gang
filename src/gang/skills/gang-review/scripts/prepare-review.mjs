#!/usr/bin/env node
// fallow-ignore-file unused-file
// Runtime entry point referenced from SKILL.md; the static import graph cannot see that link.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const MAX_BUFFER = 256 * 1024 * 1024;
const OWNERSHIP_MARKER = "pi-gang-review-v1\n";
const EXCLUDED_PATTERNS = [
    [/\.lock$/, "lock file"],
    [/-lock\.(json|yaml|yml)$/, "lock file"],
    [/package-lock\.json$/, "lock file"],
    [/yarn\.lock$/, "lock file"],
    [/pnpm-lock\.yaml$/, "lock file"],
    [/Cargo\.lock$/, "lock file"],
    [/Gemfile\.lock$/, "lock file"],
    [/poetry\.lock$/, "lock file"],
    [/composer\.lock$/, "lock file"],
    [/flake\.lock$/, "lock file"],
    [/\.min\.(js|css)$/, "minified"],
    [/\.generated\./, "generated"],
    [/\.snap$/, "snapshot"],
    [/\.map$/, "source map"],
    [/^dist\//, "build output"],
    [/^build\//, "build output"],
    [/^out\//, "build output"],
    [/(^|\/)node_modules\//, "vendor"],
    [/(^|\/)vendor\//, "vendor"],
    [/\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, "image"],
    [/\.(woff|woff2|ttf|eot|otf)$/i, "font"],
    [/\.(pdf|zip|tar|gz|rar|7z)$/i, "binary"],
];
function usage() {
    return [
        "Usage:",
        "  prepare-review.mjs worktree",
        "  prepare-review.mjs base <branch-or-ref>",
        "  prepare-review.mjs commit <commit>",
        "  prepare-review.mjs pr [number-or-url-or-branch]",
        "  prepare-review.mjs cleanup <cleanup-path>",
    ].join("\n");
}
function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? process.cwd(),
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error)
        throw result.error;
    const allowed = options.allowedExitCodes ?? [0];
    if (!allowed.includes(result.status ?? -1)) {
        const detail = (result.stderr || result.stdout || "command failed").trim();
        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
    return result.stdout;
}
function git(repoRoot, args, options = {}) {
    return run("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], options);
}
function validateRef(ref, mode) {
    if (ref?.startsWith("-"))
        throw new Error(`${mode} ref must not start with '-': ${ref}`);
}
function resolveCommit(repoRoot, ref) {
    validateRef(ref, "git");
    return git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}
const SIMPLE_GIT_ESCAPES = {
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
    '"': '"',
    "\\": "\\",
};
function decodeLiteralCodePoint(body, index) {
    const codePoint = body.codePointAt(index);
    return {
        text: String.fromCodePoint(codePoint),
        nextIndex: index + (codePoint > 0xffff ? 2 : 1),
    };
}
function decodeOctalRun(body, startIndex) {
    const bytes = [];
    let index = startIndex;
    while (body[index] === "\\") {
        const match = body.slice(index + 1).match(/^[0-7]{1,3}/);
        if (!match)
            break;
        bytes.push(Number.parseInt(match[0], 8));
        index += match[0].length + 1;
    }
    if (bytes.length === 0)
        return undefined;
    return { text: Buffer.from(bytes).toString("utf8"), nextIndex: index };
}
function decodeGitEscape(body, index) {
    const octal = decodeOctalRun(body, index);
    if (octal)
        return octal;
    const escape = body[index + 1];
    return escape === undefined
        ? { text: "\\", nextIndex: index + 1 }
        : { text: SIMPLE_GIT_ESCAPES[escape] ?? escape, nextIndex: index + 2 };
}
function decodeGitPath(value) {
    const raw = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (!(raw.startsWith('"') && raw.endsWith('"')))
        return raw;
    const body = raw.slice(1, -1);
    let decoded = "";
    let index = 0;
    while (index < body.length) {
        const part = body[index] === "\\" ? decodeGitEscape(body, index) : decodeLiteralCodePoint(body, index);
        decoded += part.text;
        index = part.nextIndex;
    }
    return decoded;
}
function stripDiffPrefix(path) {
    return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}
function extendedHeaderPath(chunk) {
    for (const prefix of ["rename to ", "copy to "]) {
        const line = chunk.split("\n").find((candidate) => candidate.startsWith(prefix));
        if (line)
            return decodeGitPath(line.slice(prefix.length));
    }
    return undefined;
}
function samePathFromHeader(header) {
    if (!header.startsWith("a/"))
        return undefined;
    let boundary = header.indexOf(" b/");
    while (boundary !== -1) {
        const oldPath = header.slice(2, boundary);
        const newPath = header.slice(boundary + 3);
        if (oldPath === newPath)
            return decodeGitPath(newPath);
        boundary = header.indexOf(" b/", boundary + 1);
    }
    return undefined;
}
function pathFromHeader(chunk) {
    const header = chunk.split("\n", 1)[0]?.slice("diff --git ".length) ?? "";
    const tokens = header.match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
    if (tokens.length === 2)
        return stripDiffPrefix(decodeGitPath(tokens[1]));
    return samePathFromHeader(header);
}
function markerPath(chunk, marker) {
    const line = chunk.split("\n").find((candidate) => candidate.startsWith(`${marker} `));
    if (!line)
        return undefined;
    const rawValue = line.slice(marker.length + 1);
    const quoted = rawValue.match(/^"(?:\\.|[^"])*"/);
    const value = quoted?.[0] ?? rawValue.split("\t", 1)[0];
    if (value === "/dev/null")
        return undefined;
    return stripDiffPrefix(decodeGitPath(value));
}
function pathFromChunk(chunk) {
    return markerPath(chunk, "+++") ?? markerPath(chunk, "---") ?? extendedHeaderPath(chunk) ?? pathFromHeader(chunk);
}
function countChangedLines(chunk) {
    let linesAdded = 0;
    let linesRemoved = 0;
    let inHunk = false;
    for (const line of chunk.split("\n")) {
        if (line.startsWith("@@")) {
            inHunk = true;
            continue;
        }
        if (!inHunk)
            continue;
        if (line.startsWith("+"))
            linesAdded += 1;
        else if (line.startsWith("-"))
            linesRemoved += 1;
    }
    return { linesAdded, linesRemoved };
}
function exclusionReason(path, chunk) {
    if (/^GIT binary patch$/m.test(chunk) || /^Binary files .+ differ$/m.test(chunk))
        return "binary";
    for (const [pattern, reason] of EXCLUDED_PATTERNS) {
        if (pattern.test(path))
            return reason;
    }
    return undefined;
}
export function parseDiff(rawDiff) {
    const reviewable = new Map();
    const excluded = new Map();
    const chunks = rawDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
    for (const chunk of chunks) {
        const path = pathFromChunk(chunk);
        if (!path)
            continue;
        const counts = countChangedLines(chunk);
        const reason = exclusionReason(path, chunk);
        if (reason) {
            const current = excluded.get(path) ?? { path, reason, linesAdded: 0, linesRemoved: 0 };
            current.linesAdded += counts.linesAdded;
            current.linesRemoved += counts.linesRemoved;
            excluded.set(path, current);
            continue;
        }
        const current = reviewable.get(path) ?? { path, linesAdded: 0, linesRemoved: 0, chunks: [] };
        current.linesAdded += counts.linesAdded;
        current.linesRemoved += counts.linesRemoved;
        current.chunks.push(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
        reviewable.set(path, current);
    }
    return {
        files: [...reviewable.values()].sort((a, b) => a.path.localeCompare(b.path)),
        excluded: [...excluded.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
}
export function recommendedReviewerCount(totalLines, fileCount) {
    if (fileCount === 0)
        return 0;
    if (totalLines < 100 || fileCount <= 2)
        return 1;
    if (totalLines < 500)
        return Math.min(2, fileCount);
    if (totalLines < 2000)
        return Math.min(4, Math.ceil(fileCount / 3));
    if (totalLines < 5000)
        return Math.min(8, Math.ceil(fileCount / 2));
    return Math.min(16, fileCount);
}
function readUntrackedDiffs(repoRoot) {
    const paths = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean);
    const diffs = paths.map((path) => git(repoRoot, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", path], {
        allowedExitCodes: [0, 1],
    }));
    return { paths, diff: diffs.filter(Boolean).join("\n") };
}
function prepareWorktree(repoRoot) {
    const unstaged = git(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--no-color"]);
    const staged = git(repoRoot, ["diff", "--cached", "--no-ext-diff", "--find-renames", "--no-color"]);
    const untracked = readUntrackedDiffs(repoRoot);
    return {
        rawDiff: [unstaged, staged, untracked.diff].filter(Boolean).join("\n"),
        source: {
            kind: "worktree",
            label: "Uncommitted changes (unstaged, staged, and untracked)",
            repoRoot,
            untrackedFiles: untracked.paths,
        },
    };
}
function prepareBase(repoRoot, ref) {
    if (!ref)
        throw new Error(`base mode requires a branch or ref\n${usage()}`);
    const baseSha = resolveCommit(repoRoot, ref);
    const headSha = resolveCommit(repoRoot, "HEAD");
    const mergeBaseSha = git(repoRoot, ["merge-base", baseSha, headSha]).trim();
    return {
        rawDiff: git(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--no-color", `${mergeBaseSha}..${headSha}`]),
        source: {
            kind: "base",
            label: `Changes from merge-base with ${ref} to HEAD`,
            repoRoot,
            requestedRef: ref,
            baseSha,
            mergeBaseSha,
            headSha,
        },
    };
}
function prepareCommit(repoRoot, ref) {
    if (!ref)
        throw new Error(`commit mode requires a commit\n${usage()}`);
    const commitSha = resolveCommit(repoRoot, ref);
    const revision = git(repoRoot, ["rev-list", "--parents", "-n", "1", commitSha]).trim().split(/\s+/);
    const parentSha = revision[1] ?? null;
    const rawDiff = parentSha
        ? git(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--no-color", parentSha, commitSha])
        : git(repoRoot, ["show", "--format=", "--no-ext-diff", "--find-renames", "--no-color", commitSha]);
    return {
        rawDiff,
        source: {
            kind: "commit",
            label: `Commit ${ref}`,
            repoRoot,
            requestedRef: ref,
            commitSha,
            parentSha,
        },
    };
}
function repoFromPrUrl(url) {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname !== "github.com" || parts.length < 4 || parts[2] !== "pull") {
        throw new Error(`Unexpected GitHub PR URL: ${url}`);
    }
    return `${parts[0]}/${parts[1]}`;
}
function preparePr(repoRoot, ref) {
    validateRef(ref, "PR");
    const target = ref ? [ref] : [];
    const fields = "number,url,headRefOid,baseRefOid,headRepository";
    const metadata = JSON.parse(run("gh", ["pr", "view", ...target, "--json", fields], { cwd: repoRoot }));
    const baseRepo = repoFromPrUrl(metadata.url);
    const headRepo = metadata.headRepository?.nameWithOwner ?? baseRepo;
    const comparePath = `repos/${baseRepo}/compare/${metadata.baseRefOid}...${metadata.headRefOid}`;
    const mergeBaseSha = run("gh", ["api", comparePath, "--jq", ".merge_base_commit.sha"], { cwd: repoRoot }).trim();
    if (!mergeBaseSha)
        throw new Error(`GitHub returned no merge base for ${metadata.url}`);
    return {
        rawDiff: run("gh", ["pr", "diff", ...target, "--color", "never"], { cwd: repoRoot }),
        source: {
            kind: "pr",
            label: `GitHub PR ${metadata.url}`,
            repoRoot,
            requestedRef: ref ?? null,
            number: metadata.number,
            url: metadata.url,
            baseRepo,
            headRepo,
            baseSha: metadata.baseRefOid,
            mergeBaseSha,
            headSha: metadata.headRefOid,
        },
    };
}
function materializePlan(prepared) {
    const parsed = parseDiff(prepared.rawDiff);
    const totalAdded = parsed.files.reduce((sum, file) => sum + file.linesAdded, 0);
    const totalRemoved = parsed.files.reduce((sum, file) => sum + file.linesRemoved, 0);
    const totalLines = totalAdded + totalRemoved;
    if (parsed.files.length === 0) {
        return {
            source: prepared.source,
            files: [],
            excluded: parsed.excluded,
            totals: { files: 0, added: 0, removed: 0, lines: 0 },
            recommendedReviewers: 0,
            cleanupPath: null,
        };
    }
    const cleanupPath = mkdtempSync(join(tmpdir(), "gang-review-"));
    try {
        chmodSync(cleanupPath, 0o700);
        const markerPath = join(cleanupPath, ".gang-review-owned");
        writeFileSync(markerPath, OWNERSHIP_MARKER, { mode: 0o600 });
        chmodSync(markerPath, 0o600);
        const diffDir = join(cleanupPath, "diffs");
        mkdirSync(diffDir, { mode: 0o700 });
        const files = parsed.files.map((file, index) => {
            const patch = `${file.chunks.join("\n")}\n`;
            const diffPath = join(diffDir, `${String(index + 1).padStart(4, "0")}.patch`);
            writeFileSync(diffPath, patch, { mode: 0o600 });
            chmodSync(diffPath, 0o600);
            return {
                path: file.path,
                linesAdded: file.linesAdded,
                linesRemoved: file.linesRemoved,
                type: extname(file.path).slice(1).toLowerCase(),
                diffPath,
                patchSha256: createHash("sha256").update(patch).digest("hex"),
            };
        });
        return {
            source: prepared.source,
            files,
            excluded: parsed.excluded,
            totals: { files: files.length, added: totalAdded, removed: totalRemoved, lines: totalLines },
            recommendedReviewers: recommendedReviewerCount(totalLines, files.length),
            cleanupPath,
        };
    }
    catch (error) {
        rmSync(cleanupPath, { recursive: true, force: true });
        throw error;
    }
}
function cleanupReview(path) {
    if (!path)
        throw new Error(`cleanup mode requires a path\n${usage()}`);
    const candidate = resolve(path);
    const realTempRoot = realpathSync(tmpdir());
    const realCandidate = realpathSync(candidate);
    const markerPath = join(realCandidate, ".gang-review-owned");
    let ownsDirectory = false;
    try {
        ownsDirectory = !lstatSync(markerPath).isSymbolicLink() && readFileSync(markerPath, "utf8") === OWNERSHIP_MARKER;
    }
    catch {
        ownsDirectory = false;
    }
    if (lstatSync(candidate).isSymbolicLink() ||
        dirname(realCandidate) !== realTempRoot ||
        !/^gang-review-[A-Za-z0-9]{6}$/.test(basename(realCandidate)) ||
        !ownsDirectory) {
        throw new Error(`refusing to remove unsafe cleanup path: ${path}`);
    }
    rmSync(realCandidate, { recursive: true, force: false });
    process.stdout.write(`Removed ${candidate}\n`);
}
function main() {
    const [mode, ref, ...extra] = process.argv.slice(2);
    if (!mode || extra.length > 0 || !["worktree", "base", "commit", "pr", "cleanup"].includes(mode)) {
        throw new Error(usage());
    }
    if (mode === "worktree" && ref)
        throw new Error(usage());
    if (mode === "cleanup") {
        cleanupReview(ref);
        return;
    }
    const repoRoot = run("git", ["rev-parse", "--show-toplevel"]).trim();
    const prepared = mode === "worktree"
        ? prepareWorktree(repoRoot)
        : mode === "base"
            ? prepareBase(repoRoot, ref)
            : mode === "commit"
                ? prepareCommit(repoRoot, ref)
                : preparePr(repoRoot, ref);
    process.stdout.write(`${JSON.stringify(materializePlan(prepared), null, 2)}\n`);
}
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) {
    try {
        main();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`gang-review: ${message}\n`);
        process.exitCode = 1;
    }
}
