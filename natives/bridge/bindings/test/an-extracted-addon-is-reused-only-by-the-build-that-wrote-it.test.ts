/**
 * An extracted addon is reused only by the build that wrote it.
 *
 * WHY THIS SUITE EXISTS. A compiled binary extracts its addon into
 * `<data home>/veyyon/natives/<version>/` and reused whatever file it found there whose size matched
 * the manifest. Every local rebuild of one version extracts into that one directory, and a change
 * that keeps the code the same length leaves the `.node` the same size, so a rebuilt binary loaded
 * the previous build's addon. A same-size file no extraction wrote was reused the same way: with a
 * zero-filled file of the right size in that directory, every launch of the shipped binary failed
 * with "Failed to load veyyon_natives native addon" until the directory was deleted by hand.
 *
 * THE CLASS. A reuse decision made from a property two different files share. Each extraction now
 * writes a stamp beside the addon holding the manifest's `sha256` and the inode and modification
 * time of the file it wrote, and the reuse check compares all three.
 *
 * WHAT THESE CASES DO. They drive both loader passes that write an extracted addon, each with the
 * variants the extraction plan assigns it, so every variant in the bundle is covered by the pass
 * that would write it, and a variant the plan assigns to neither fails the coverage case. For each
 * pass the directory is first left in a state another writer could leave it in, then build B
 * extracts, and the bytes on disk must be build B's. Each state differs from a current file in one
 * field the check reads: the digest, the stamp's presence, its syntax, the inode, the modification
 * time. The reuse case proves the saving survives: a second pass by the same build rewrites nothing.
 * A manifest entry with no digest is reported rather than extracted.
 *
 * WHAT THEY DO NOT PROVE. The bytes are never hashed at launch, so a file rewritten in place with the
 * same size inside one tick of the filesystem clock keeps the stamp's inode and modification time and
 * is reused; the in-place case moves the clock forward to stay out of that tick. Two processes
 * extracting different builds at the same moment are not driven, so a stamp that records the target's
 * identity after the rename instead of the temp file's before it is not caught. `embed-native.ts`
 * computing the digest is not driven here.
 *
 * MUTATIONS CHECKED. The size-only check this replaced fails 10 of 15 (every foreign state, both
 * passes). Each of these fails exactly its own two cases: dropping the digest, inode, or
 * modification-time comparison; treating a missing or an unparseable stamp as current; writing no
 * stamp (the reuse cases); dropping the missing-digest refusal.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type EmbeddedAddonBundle,
	type EmbeddedAddonExtractionContext,
	type EmbeddedAddonExtractionPlan,
	type EmbeddedAddonFile,
	extractRemainingEmbeddedAddons,
	maybeExtractEmbeddedAddon,
	planEmbeddedAddonExtraction,
} from "../native/loader-state.js";

const VERSION = "9.9.9";
const PLATFORM_TAG = `${process.platform}-${process.arch}`;

/** The variant space. A variant added to the manifest type and not here fails `check:ts`. */
const ALL_VARIANTS = ["modern", "baseline", "default"] as const;
type UnlistedVariant = Exclude<EmbeddedAddonFile["variant"], (typeof ALL_VARIANTS)[number]>;
const EVERY_VARIANT_IS_LISTED: UnlistedVariant extends never ? true : false = true;

interface Build {
	bundle: EmbeddedAddonBundle;
	bytes: Map<string, Buffer>;
}

/** Every variant in its own archive, with bytes that differ between builds and keep one size. */
async function buildOf(dir: string, label: "A" | "B"): Promise<Build> {
	const root = path.join(dir, `build-${label}`);
	fs.mkdirSync(root, { recursive: true });
	const bytes = new Map<string, Buffer>();
	const files: EmbeddedAddonFile[] = [];
	for (const variant of ALL_VARIANTS) {
		const filename = `veyyon_natives.${PLATFORM_TAG}-${variant}.node`;
		const content = Buffer.from(`${label}:${variant}`.padEnd(4096, "."));
		const archiveFilename = `embedded-addons.${PLATFORM_TAG}-${variant}.tar.gz`;
		const archivePath = path.join(root, archiveFilename);
		fs.writeFileSync(archivePath, await new Bun.Archive({ [filename]: content }, { compress: "gzip" }).bytes());
		bytes.set(filename, content);
		files.push({
			variant,
			filename,
			size: content.length,
			sha256: createHash("sha256").update(content).digest("hex"),
			archive: { format: "tar.gz", filename: archiveFilename, filePath: archivePath },
		});
	}
	return { bundle: { platformTag: PLATFORM_TAG, version: VERSION, files }, bytes };
}

function contextFor(dir: string): EmbeddedAddonExtractionContext {
	return {
		isCompiledBinary: true,
		platformTag: PLATFORM_TAG,
		packageVersion: VERSION,
		selectedVariant: "modern",
		versionedDir: path.join(dir, "natives", VERSION),
	};
}

interface Pass {
	name: string;
	/** Run the pass and return the errors it recorded. */
	run: (ctx: EmbeddedAddonExtractionContext, bundle: EmbeddedAddonBundle) => string[];
	files: (plan: EmbeddedAddonExtractionPlan) => EmbeddedAddonFile[];
}

/** The two loader passes that write an extracted addon, with the files the plan assigns each. */
const PASSES: Pass[] = [
	{
		name: "the launch pass",
		run: (ctx, bundle) => {
			const errors: string[] = [];
			maybeExtractEmbeddedAddon(ctx, errors, bundle);
			return errors;
		},
		files: plan => (plan.selected ? [plan.selected] : []),
	},
	{
		name: "the fallback pass",
		run: (ctx, bundle) => {
			// The loader reaches this pass only after the launch pass created the directory.
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
			const errors: string[] = [];
			extractRemainingEmbeddedAddons(ctx, errors, bundle);
			return errors;
		},
		files: plan => plan.remaining,
	},
];

function planFor(ctx: EmbeddedAddonExtractionContext, bundle: EmbeddedAddonBundle): EmbeddedAddonExtractionPlan {
	return planEmbeddedAddonExtraction({
		files: bundle.files,
		arch: process.arch,
		selectedVariant: ctx.selectedVariant,
	});
}

/**
 * Replace the file at `target` the way `rsync -a` does: a new inode carrying the old file's
 * modification time to the nanosecond, so the inode is the only stat field that differs.
 */
function replaceKeepingModificationTime(target: string, content: Buffer): void {
	const temp = `${target}.replacement`;
	const before = fs.statSync(target, { bigint: true });
	fs.writeFileSync(temp, content);
	execFileSync("touch", ["-r", target, temp]);
	fs.renameSync(temp, target);
	const after = fs.statSync(target, { bigint: true });
	expect(after.mtimeNs).toBe(before.mtimeNs);
	expect(after.ino).not.toBe(before.ino);
}

interface Foreign {
	name: string;
	/** Leave the directory as another writer would, for the files `pass` writes. */
	plant: (input: {
		ctx: EmbeddedAddonExtractionContext;
		pass: Pass;
		files: EmbeddedAddonFile[];
		a: Build;
		b: Build;
	}) => void;
}

const FOREIGN: Foreign[] = [
	{
		name: "another build of the same version and size",
		plant: ({ ctx, pass, a }) => {
			expect(pass.run(ctx, a.bundle)).toEqual([]);
		},
	},
	{
		name: "a same-size file with no stamp, as a cache written before stamps existed",
		plant: ({ ctx, files }) => {
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
			for (const file of files) {
				fs.writeFileSync(path.join(ctx.versionedDir, file.filename), Buffer.alloc(file.size ?? 0));
			}
		},
	},
	{
		name: "a file replaced since build B stamped it",
		plant: ({ ctx, pass, files, a, b }) => {
			expect(pass.run(ctx, b.bundle)).toEqual([]);
			for (const file of files) {
				replaceKeepingModificationTime(
					path.join(ctx.versionedDir, file.filename),
					a.bytes.get(file.filename) as Buffer,
				);
			}
		},
	},
	{
		name: "a file rewritten in place since build B stamped it",
		plant: ({ ctx, pass, files, a, b }) => {
			expect(pass.run(ctx, b.bundle)).toEqual([]);
			for (const file of files) {
				const target = path.join(ctx.versionedDir, file.filename);
				const before = fs.statSync(target);
				fs.writeFileSync(target, a.bytes.get(file.filename) as Buffer);
				// A later write, outside the tick the extraction wrote in. Same inode, same size.
				fs.utimesSync(target, before.atime, new Date(before.mtimeMs + 2_000));
				expect(fs.statSync(target).ino).toBe(before.ino);
			}
		},
	},
	{
		name: "an unparseable stamp",
		plant: ({ ctx, pass, files, a }) => {
			expect(pass.run(ctx, a.bundle)).toEqual([]);
			for (const file of files) fs.writeFileSync(path.join(ctx.versionedDir, `${file.filename}.stamp`), "{");
		},
	},
];

async function withScratch(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-addon-identity-"));
	try {
		await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("an extracted addon is reused only by the build that wrote it", () => {
	it("covers every variant in the bundle with the pass that writes it", async () => {
		expect(EVERY_VARIANT_IS_LISTED).toBe(true);
		await withScratch(async dir => {
			const { bundle } = await buildOf(dir, "A");
			const plan = planFor(contextFor(dir), bundle);
			const covered = PASSES.flatMap(pass => pass.files(plan).map(file => file.filename)).sort();
			expect(covered).toEqual(bundle.files.map(file => file.filename).sort());
		});
	});

	for (const pass of PASSES) {
		describe(pass.name, () => {
			for (const foreign of FOREIGN) {
				it(`replaces ${foreign.name}`, async () => {
					await withScratch(async dir => {
						const a = await buildOf(dir, "A");
						const b = await buildOf(dir, "B");
						const ctx = contextFor(dir);
						const files = pass.files(planFor(ctx, b.bundle));
						expect(files.length).toBeGreaterThan(0);
						foreign.plant({ ctx, pass, files, a, b });

						expect(pass.run(ctx, b.bundle)).toEqual([]);
						for (const file of files) {
							const onDisk = fs.readFileSync(path.join(ctx.versionedDir, file.filename));
							expect(onDisk.equals(b.bytes.get(file.filename) as Buffer), file.filename).toBe(true);
						}
					});
				});
			}

			it("rewrites nothing when the same build runs it again", async () => {
				await withScratch(async dir => {
					const b = await buildOf(dir, "B");
					const ctx = contextFor(dir);
					const files = pass.files(planFor(ctx, b.bundle));
					expect(pass.run(ctx, b.bundle)).toEqual([]);
					const identityOf = (file: EmbeddedAddonFile): string => {
						const stat = fs.statSync(path.join(ctx.versionedDir, file.filename), { bigint: true });
						return `${stat.ino}:${stat.mtimeNs}`;
					};
					const before = files.map(identityOf);

					expect(pass.run(ctx, b.bundle)).toEqual([]);
					expect(files.map(identityOf)).toEqual(before);
				});
			});

			it("reports a manifest entry with no sha256 instead of reusing the file on disk", async () => {
				// A build whose manifest lost the digest cannot tell its file from another build's, so the
				// pass records an error naming it and leaves the directory as it found it.
				await withScratch(async dir => {
					const a = await buildOf(dir, "A");
					const b = await buildOf(dir, "B");
					const ctx = contextFor(dir);
					const files = pass.files(planFor(ctx, b.bundle));
					expect(pass.run(ctx, a.bundle)).toEqual([]);
					const unidentified = { ...b.bundle, files: b.bundle.files.map(file => ({ ...file, sha256: "" })) };

					const errors = pass.run(ctx, unidentified);

					expect(errors.length).toBe(files.length);
					for (const [index, file] of files.entries()) {
						expect(errors[index]).toContain(`has no sha256 for ${file.filename}`);
						const onDisk = fs.readFileSync(path.join(ctx.versionedDir, file.filename));
						expect(onDisk.equals(a.bytes.get(file.filename) as Buffer), file.filename).toBe(true);
					}
				});
			});
		});
	}
});
