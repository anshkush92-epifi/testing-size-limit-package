#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

// edited to work with the appdir by @raphaelbadia

import path from 'path';
import fs from 'fs';
import gzSize from 'gzip-size';
import * as mkdirp from 'mkdirp';

// Pull options from `package.json`
const options = getOptions();
const BUILD_OUTPUT_DIRECTORY = getBuildOutputDirectory(options);

// first we check to make sure that the build output directory exists
const nextMetaRoot = path.join(process.cwd(), BUILD_OUTPUT_DIRECTORY);
try {
  fs.accessSync(nextMetaRoot, fs.constants.R_OK);
} catch (err) {
  console.error(
    `No build output found at "${nextMetaRoot}" - you may not have your working directory set correctly, or not have run "next build".`,
    err,
  );
  process.exit(1);
}

// if so, we can import the build manifest
const buildManifestPath = path.join(nextMetaRoot, 'build-manifest.json');
const appBuildManifestPath = path.join(nextMetaRoot, 'app-build-manifest.json');
const appPathRoutesManifestPath = path.join(nextMetaRoot, 'app-path-routes-manifest.json');

const buildMeta = JSON.parse(
  fs.readFileSync(buildManifestPath, 'utf8'),
);
const appDirMeta = fs.existsSync(appBuildManifestPath)
  ? JSON.parse(fs.readFileSync(appBuildManifestPath, 'utf8'))
  : { pages: {} };

const appPathRoutes = fs.existsSync(appPathRoutesManifestPath)
  ? JSON.parse(fs.readFileSync(appPathRoutesManifestPath, 'utf8'))
  : {};

// this memory cache ensures we dont read any script file more than once
// bundles are often shared between pages
const memoryCache = {};

// since _app is the template that all other pages are rendered into,
// every page must load its scripts. we'll measure its size here
// page router manifest may be present, but we don't use it in current output

// next, we calculate the size of each page's scripts, after
// subtracting out the global scripts
// intentionally skipping page router sizes in output; compute only if needed later

const globalAppDirBundle = buildMeta?.rootMainFiles || [];
const globalAppDirBundleSizes = getScriptSizes(globalAppDirBundle || []);

const appDirPages = appDirMeta?.pages || {};
const allAppDirSizes = Object.entries(appDirPages).reduce(
  (acc, [pagePath, scriptPaths]) => {
    const scriptSizes = getScriptSizes(
      (scriptPaths || []).filter(
        (scriptPath) => !globalAppDirBundle.includes(scriptPath),
      ),
    );
    acc[pagePath] = scriptSizes;
    return acc;
  },
  {},
);

// compute per-file sizes for all files in the app router bundle
const allFiles = new Set([
  ...globalAppDirBundle,
  ...Object.values(appDirPages).flat(),
]);

const fileSizes = {};
for (const file of allFiles) {
  const [raw, gzip] = getScriptSize(file);
  fileSizes[file] = { raw, gzip };
}

// prepare previous analysis for diffing if present
const analyzeDir = path.join(nextMetaRoot, 'analyze/');
const analysisPath = path.join(analyzeDir, '__bundle_analysis.json');
let previousAnalysis = null;
if (fs.existsSync(analysisPath)) {
  try {
    previousAnalysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  } catch {
    previousAnalysis = null;
  }
}

// discover app routes and best-effort source file paths
const routeToSource = Object.entries(appPathRoutes).reduce(
  (acc, [sourceLike, routePath]) => {
    acc[routePath] = {
      source: sourceLike,
      sourceFile: resolveSourceFile(sourceLike),
    };
    return acc;
  },
  {},
);

// build rich output for current run
const outputJson = {
  __global: globalAppDirBundleSizes,
  __pages: allAppDirSizes,
  __files: fileSizes,
  __routes: routeToSource,
  __rootMainFiles: globalAppDirBundle,
};

// compute and log diffs (previousAnalysis is compat schema; guards handle missing keys)
logDiffs(previousAnalysis, outputJson);

// write outputs
mkdirp.sync(analyzeDir);

// 1) Compat output for nextjs-bundle-analysis compare (only pages + __global)
const compatJson = { __global: globalAppDirBundleSizes, ...allAppDirSizes };
fs.writeFileSync(analysisPath, JSON.stringify(compatJson));

// 2) Extended output for richer local inspection
const extendedPath = path.join(analyzeDir, '__bundle_analysis_extended.json');
fs.writeFileSync(extendedPath, JSON.stringify(outputJson));

// --------------
// Util Functions
// --------------

// given an array of scripts, return the total of their combined file sizes
function getScriptSizes(scriptPaths) {
  const res = scriptPaths.reduce(
    (acc, scriptPath) => {
      const [rawSize, gzipSize] = getScriptSize(scriptPath);
      acc.raw += rawSize;
      acc.gzip += gzipSize;

      return acc;
    },
    { raw: 0, gzip: 0 },
  );

  return res;
}

// given an individual path to a script, return its file size
function getScriptSize(scriptPath) {
  const encoding = 'utf8';
  const p = path.join(nextMetaRoot, scriptPath);

  let rawSize, gzipSize;
  if (Object.keys(memoryCache).includes(p)) {
    rawSize = memoryCache[p][0];
    gzipSize = memoryCache[p][1];
  } else {
    if (!fs.existsSync(p)) {
      rawSize = 0;
      gzipSize = 0;
    } else {
      const textContent = fs.readFileSync(p, encoding);
      rawSize = Buffer.byteLength(textContent, encoding);
      gzipSize = gzSize.sync(textContent);
    }
    memoryCache[p] = [rawSize, gzipSize];
  }

  return [rawSize, gzipSize];
}

// pretty console output for diffs between runs
function logDiffs(prev, curr) {
  const prevGlobal = prev?.__global || { raw: 0, gzip: 0 };
  const currGlobal = curr.__global || { raw: 0, gzip: 0 };
  const dGlobalRaw = currGlobal.raw - prevGlobal.raw;
  const dGlobalGzip = currGlobal.gzip - prevGlobal.gzip;

  console.log(
    JSON.stringify({ __global: currGlobal, __delta_global: { raw: dGlobalRaw, gzip: dGlobalGzip } }),
  );

  const prevFiles = prev?.__files || {};
  const currFiles = curr.__files || {};
  const fileKeys = new Set([...Object.keys(prevFiles), ...Object.keys(currFiles)]);

  const changedFiles = [];
  const newFiles = [];
  const removedFiles = [];

  for (const key of fileKeys) {
    const p = prevFiles[key];
    const c = currFiles[key];
    if (p && !c) {
      removedFiles.push({ file: key, prev: p });
    } else if (!p && c) {
      newFiles.push({ file: key, curr: c });
    } else if (p && c) {
      const dr = c.raw - p.raw;
      const dg = c.gzip - p.gzip;
      if (dr !== 0 || dg !== 0) {
        changedFiles.push({ file: key, prev: p, curr: c, delta: { raw: dr, gzip: dg } });
      }
    }
  }

  if (changedFiles.length || newFiles.length || removedFiles.length) {
    console.log('Bundle file changes:');
  }
  for (const f of changedFiles) {
    console.log(`CHANGED ${f.file} raw=${f.curr.raw} (Δ ${sign(f.delta.raw)}) gzip=${f.curr.gzip} (Δ ${sign(f.delta.gzip)})`);
  }
  for (const f of newFiles) {
    console.log(`NEW     ${f.file} raw=${f.curr.raw} gzip=${f.curr.gzip}`);
  }
  for (const f of removedFiles) {
    console.log(`REMOVED ${f.file} raw=${f.prev.raw} gzip=${f.prev.gzip}`);
  }

  const prevPages = prev?.__pages || {};
  const currPages = curr.__pages || {};
  const pageKeys = new Set([...Object.keys(prevPages), ...Object.keys(currPages)]);
  const pageChanges = [];
  for (const key of pageKeys) {
    const p = prevPages[key] || { raw: 0, gzip: 0 };
    const c = currPages[key] || { raw: 0, gzip: 0 };
    const dr = c.raw - p.raw;
    const dg = c.gzip - p.gzip;
    if (dr !== 0 || dg !== 0) {
      pageChanges.push({ page: key, prev: p, curr: c, delta: { raw: dr, gzip: dg } });
    }
  }
  if (pageChanges.length) {
    console.log('Page bundle changes:');
    for (const p of pageChanges) {
      console.log(`PAGE ${p.page} raw=${p.curr.raw} (Δ ${sign(p.delta.raw)}) gzip=${p.curr.gzip} (Δ ${sign(p.delta.gzip)})`);
    }
  }

  // routes added/removed since last run
  const prevRoutes = prev?.__routes || {};
  const currRoutes = curr.__routes || {};
  const prevRouteKeys = new Set(Object.keys(prevRoutes));
  const currRouteKeys = new Set(Object.keys(currRoutes));
  const newRoutes = [...currRouteKeys].filter((r) => !prevRouteKeys.has(r));
  const removedRoutes = [...prevRouteKeys].filter((r) => !currRouteKeys.has(r));
  if (newRoutes.length) {
    console.log('New pages detected:');
    for (const r of newRoutes) {
      const info = currRoutes[r];
      console.log(`NEW PAGE ${r} (source: ${info.sourceFile || info.source})`);
      // show chunks contributing to client bundle for this page (root files in app router)
      const rootFiles = curr.__rootMainFiles || [];
      for (const f of rootFiles) {
        const sz = currFiles[f] || { raw: 0, gzip: 0 };
        console.log(`  uses ${f} raw=${sz.raw} gzip=${sz.gzip}`);
      }
    }
  }
  if (removedRoutes.length) {
    console.log('Removed pages:');
    for (const r of removedRoutes) {
      const info = prevRoutes[r];
      console.log(`REMOVED PAGE ${r} (source: ${info?.sourceFile || info?.source || 'unknown'})`);
    }
  }
}

function sign(n) {
  return n === 0 ? '0' : (n > 0 ? `+${n}` : `${n}`);
}

// try to resolve a concrete file path for an app route source-like key
function resolveSourceFile(sourceLike) {
  // sourceLike looks like "/(routes)/one/page"; try typical extensions
  const exts = ['tsx', 'ts', 'jsx', 'js', 'mdx'];
  const rel = path.join('app', sourceLike.replace(/^\//, ''));
  for (const ext of exts) {
    const candidate = path.join(process.cwd(), `${rel}.${ext}`);
    if (fs.existsSync(candidate)) return path.relative(process.cwd(), candidate);
  }
  // also support route handlers like "/favicon.ico/route"
  for (const ext of exts) {
    const candidate = path.join(process.cwd(), `${rel}/route.${ext}`);
    if (fs.existsSync(candidate)) return path.relative(process.cwd(), candidate);
  }
  return null;
}

/**
 * Reads options from `package.json`
 */
function getOptions(pathPrefix = process.cwd()) {
  const pkgPath = path.join(pathPrefix, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return { ...pkg.nextBundleAnalysis, name: pkg.name };
}

/**
 * Gets the output build directory, defaults to `.next`
 *
 * @param {object} options the options parsed from package.json.nextBundleAnalysis using `getOptions`
 * @returns {string}
 */
function getBuildOutputDirectory(options) {
  return options.buildOutputDirectory || '.next';
}