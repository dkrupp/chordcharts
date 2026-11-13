// Renders every ChordMark (.cm) file in the repo into a single-page, two-column
// A4 chart, as both PDF and standalone HTML. The font size is the largest one at
// which the whole song fits on one page and no line wraps.
//
// Usage: node build-pdfs.mjs <repo-root> <output-dir>
//        writes <output-dir>/pdf/*.pdf and <output-dir>/html/*.html
// Env:   CHROME_PATH  path to a Chrome/Chromium executable

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as sass from 'sass';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);

// The chord-mark bundle targets browsers (it relies on DOMPurify), so songs are
// rendered inside the headless browser rather than in Node.
const chordMarkBundle = require.resolve('chord-mark/lib/chord-mark.js');

const repoRoot = path.resolve(process.argv[2] || '.');
const outDir = path.resolve(process.argv[3] || 'dist');
const pdfDir = path.join(outDir, 'pdf');
const htmlDir = path.join(outDir, 'html');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const MIN_FONT_PX = 6;
const MAX_FONT_PX = 40;
const MARGIN_MM = 10;

function findCmFiles(dir) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...findCmFiles(full));
		else if (entry.name.endsWith('.cm')) files.push(full);
	}
	return files.sort();
}

function titleCase(name) {
	return name
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s) {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const themeCss = sass.compile(
	path.join(path.dirname(require.resolve('chord-mark-themes/package.json')), 'scss/themes/print.scss'),
	{ quietDeps: true, silenceDeprecations: ['import', 'global-builtin'] }
).css;

function buildHtml(title, artist) {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
${themeCss}
@page { size: A4; margin: ${MARGIN_MM}mm; }
html, body { margin: 0; padding: 0; }
#page {
	height: calc(297mm - ${2 * MARGIN_MM}mm);
	width: calc(210mm - ${2 * MARGIN_MM}mm);
	column-count: 2;
	column-gap: 6mm;
	column-fill: auto;
	overflow: hidden;
	font-size: var(--fs);
}
#page .cmSong { font-size: 1em; padding: 0; }
.songHeader { margin: 0 0 0.5em 0; break-inside: avoid; }
.songHeader h1 { font-family: sans-serif; font-size: 1.4em; margin: 0; }
.songHeader h2 { font-family: sans-serif; font-size: 0.9em; font-weight: normal; margin: 0; color: #666; }
@media screen {
	body { background: #ddd; }
	#page { margin: 10mm auto; padding: ${MARGIN_MM}mm; background: white; box-shadow: 0 0 4mm rgba(0, 0, 0, 0.3); }
}
.cmLine, .cmChordLyricLine { break-inside: avoid; }
/* Lines never wrap; fitFontSize() rejects font sizes where a line overflows its column. */
#song .cmLine, #song .cmLine * { white-space: pre; }
#song .cmChordLyricLine { flex-wrap: nowrap; }
</style></head>
<body class="cmTheme-print"><div id="page">
<div class="songHeader"><h1>${escapeHtml(title)}</h1><h2>${escapeHtml(artist)}</h2></div>
<div id="song"></div>
</div></body></html>`;
}

// Binary-searches the largest font size (0.25px steps) for which the content
// fits into the two columns of the page without spilling into a third column,
// and no song line is wider than its column (i.e. would have to wrap).
// Returns { fontSize, fits }; fits is false if even the minimum size is too big.
async function fitFontSize(page) {
	return page.evaluate(
		(min, max) => {
			const el = document.getElementById('page');
			const lines = [...document.querySelectorAll('#song .cmLine')];
			const fits = (px) => {
				el.style.setProperty('--fs', `${px}px`);
				return (
					el.scrollWidth <= el.clientWidth + 1 &&
					lines.every((line) => line.scrollWidth <= line.clientWidth + 1)
				);
			};
			let lo = min * 4;
			let hi = max * 4;
			if (!fits(min)) return { fontSize: min, fits: false };
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (fits(mid / 4)) lo = mid;
				else hi = mid - 1;
			}
			fits(lo / 4);
			return { fontSize: lo / 4, fits: true };
		},
		MIN_FONT_PX,
		MAX_FONT_PX
	);
}

const files = findCmFiles(repoRoot);
fs.mkdirSync(pdfDir, { recursive: true });
fs.mkdirSync(htmlDir, { recursive: true });

const browser = await puppeteer.launch({
	executablePath: chromePath,
	args: ['--no-sandbox', '--disable-gpu'],
});

let failed = 0;
try {
	const page = await browser.newPage();
	for (const file of files) {
		const rel = path.relative(repoRoot, file);
		const artistDir = path.basename(path.dirname(file));
		const songName = path.basename(file, '.cm');
		try {
			const source = fs.readFileSync(file, 'utf8');
			await page.setContent(buildHtml(titleCase(songName), titleCase(artistDir)), { waitUntil: 'load' });
			await page.addScriptTag({ path: chordMarkBundle });
			await page.evaluate((src) => {
				const { parseSong, renderSong } = window['chord-mark'];
				document.getElementById('song').innerHTML = renderSong(parseSong(src));
			}, source);
			const { fontSize, fits } = await fitFontSize(page);
			const baseName = `${artistDir}-${songName}`;
			await page.pdf({
				path: path.join(pdfDir, `${baseName}.pdf`),
				format: 'A4',
				printBackground: true,
				preferCSSPageSize: true,
				pageRanges: '1',
			});
			// Standalone HTML: the fitted font size is kept as an inline style on #page,
			// the chord-mark bundle used for rendering is dropped.
			const html = await page.evaluate(() => {
				document.querySelectorAll('script').forEach((el) => el.remove());
				return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
			});
			fs.writeFileSync(path.join(htmlDir, `${baseName}.html`), html);
			const warn = fits ? '' : ' (WARNING: overflows the page or has wrapping lines even at the minimum size)';
			console.log(`${rel} -> ${baseName}.{pdf,html} @ ${fontSize}px${warn}`);
		} catch (err) {
			failed++;
			console.error(`FAILED ${rel}: ${err.message}`);
		}
	}
} finally {
	await browser.close();
}

console.log(`Built ${files.length - failed}/${files.length} charts into ${outDir}`);
if (failed) process.exit(1);
