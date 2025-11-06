#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const nextDir = path.join(cwd, '.next');
const serverDir = path.join(nextDir, 'server');

// Ensure .next exists
if (!fs.existsSync(nextDir)) {
	process.exit(0);
}

// 1) Create empty react-loadable-manifest.json if missing (App Router builds don't create it)
const reactLoadablePath = path.join(nextDir, 'react-loadable-manifest.json');
if (!fs.existsSync(reactLoadablePath)) {
	try {
		fs.writeFileSync(reactLoadablePath, '{}');
		console.log('Created compat .next/react-loadable-manifest.json');
	} catch {}
}

// 2) If root pages-manifest.json is missing, but server/pages-manifest.json exists, copy it
const rootPagesManifest = path.join(nextDir, 'pages-manifest.json');
const serverPagesManifest = path.join(serverDir, 'pages-manifest.json');
if (!fs.existsSync(rootPagesManifest) && fs.existsSync(serverPagesManifest)) {
	try {
		fs.copyFileSync(serverPagesManifest, rootPagesManifest);
		console.log('Copied server/pages-manifest.json to root .next/pages-manifest.json');
	} catch {}
}


