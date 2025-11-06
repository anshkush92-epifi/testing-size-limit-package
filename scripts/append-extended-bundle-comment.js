#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const analyzeDir = path.join(cwd, '.next', 'analyze');
const commentPath = path.join(analyzeDir, '__bundle_analysis_comment.txt');

// Prefer the primary analysis file, fallback to extended
const currPrimaryPath = path.join(analyzeDir, '__bundle_analysis.json');
const currExtendedPath = path.join(analyzeDir, '__bundle_analysis_extended.json');

const baseDir = path.join(analyzeDir, 'base', 'bundle');
const basePrimaryPath = path.join(baseDir, '__bundle_analysis.json');
const baseExtendedPath = path.join(baseDir, '__bundle_analysis_extended.json');

function readJsonSafe(p) {
	try {
		if (!fs.existsSync(p)) return null;
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
}

const curr = readJsonSafe(currPrimaryPath) || readJsonSafe(currExtendedPath);
const base = readJsonSafe(basePrimaryPath) || readJsonSafe(baseExtendedPath);

if (!curr) {
	// Nothing to add
	process.exit(0);
}

const currFiles = curr.__files || {};
const baseFiles = (base && base.__files) || {};

const keys = new Set([...Object.keys(currFiles), ...Object.keys(baseFiles)]);

const changed = [];
const added = [];
const removed = [];

for (const k of keys) {
	const c = currFiles[k];
	const b = baseFiles[k];
	if (c && !b) {
		added.push({ file: k, raw: c.raw, gzip: c.gzip });
	} else if (!c && b) {
		removed.push({ file: k, raw: b.raw, gzip: b.gzip });
	} else if (c && b) {
		const dRaw = c.raw - b.raw;
		const dGzip = c.gzip - b.gzip;
		if (dRaw !== 0 || dGzip !== 0) {
			changed.push({ file: k, raw: c.raw, gzip: c.gzip, dRaw, dGzip });
		}
	}
}

function formatBytes(n) {
	return `${n} B`;
}

function sign(n) {
	return n === 0 ? '0' : (n > 0 ? `+${n}` : `${n}`);
}

function asTable(rows) {
	if (!rows.length) return '';
	const header = '| File | Raw | Δ Raw | Gzip | Δ Gzip |\n| --- | ---: | ---: | ---: | ---: |';
	const body = rows
		.map(r => `| ${r.file} | ${formatBytes(r.raw)} | ${sign(r.dRaw || 0)} | ${formatBytes(r.gzip)} | ${sign(r.dGzip || 0)} |`)
		.join('\n');
	return `${header}\n${body}`;
}

// sort changed by largest gzip increase then raw
changed.sort((a, b) => Math.abs(b.dGzip) - Math.abs(a.dGzip) || Math.abs(b.dRaw) - Math.abs(a.dRaw));

const sections = [];
sections.push('');
sections.push('<!-- __NEXTJS_BUNDLE_EXTENDED -->');
sections.push('### Per-file bundle changes (raw and compressed)');

if (changed.length) {
	sections.push('\n#### Changed files');
	sections.push(asTable(changed));
}
if (added.length) {
	const rows = added.map(r => ({ ...r, dRaw: r.raw, dGzip: r.gzip }));
	sections.push('\n#### New files');
	sections.push(asTable(rows));
}
if (removed.length) {
	const rows = removed.map(r => ({ ...r, dRaw: -r.raw, dGzip: -r.gzip }));
	sections.push('\n#### Removed files');
	sections.push(asTable(rows));
}

// Append to comment file if it exists; otherwise create it
const content = sections.join('\n');
try {
	if (fs.existsSync(commentPath)) {
		fs.appendFileSync(commentPath, `\n\n${content}\n`);
	} else {
		fs.writeFileSync(commentPath, `${content}\n`);
	}
} catch {
	// Fail silently to avoid breaking CI comment
}
