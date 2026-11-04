import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What a plugin repository tells the pipeline about itself. It is only ever read as data, because the
// pipeline runs next to the App's token and a pull request can change this file.
export const CONFIG_FILE = '.github/pipeline.json';

const PLUGIN_FOLDER = /^[A-Za-z0-9][A-Za-z0-9.-]*\.ulanziPlugin$/;
const TEXTS = ['name', 'merging', 'notes.install', 'notes.aboutHeading', 'notes.about', 'notes.checks', 'notes.measuredAgainst'];
const LISTS = ['validation.steps', 'validation.done'];

const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const field = (plugin, path) => path.split('.').reduce((value, key) => value?.[key], plugin);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** @returns {string[]} one line for each thing missing from the file, so that all of them can be fixed at once */
export function configProblems(plugin) {
  return [
    ...(PLUGIN_FOLDER.test(plugin.pluginFolder ?? '') ? [] : ['pluginFolder must be a folder name ending in .ulanziPlugin']),
    ...TEXTS.filter((path) => !isText(field(plugin, path))).map((path) => `${path} must be text`),
    ...LISTS.filter((path) => !field(plugin, path)?.length || !field(plugin, path).every(isText)).map((path) => `${path} must be a list of text`),
  ];
}

export function readPlugin(dir) {
  const plugin = read(dir, CONFIG_FILE);
  const problems = configProblems(plugin);
  if (problems.length) throw new Error(`${CONFIG_FILE}: ${problems.join('; ')}`);
  return plugin;
}

// Edits the text and not the parsed JSON, because writing JSON back reformats the rest of the file.
// A lockfile holds the version twice at its top, and every dependency's own version further down.
const versionFiles = ({ pluginFolder }) => [
  { path: `${pluginFolder}/manifest.json`, name: 'Version', times: 1 },
  { path: `${pluginFolder}/package.json`, name: 'version', times: 1 },
  { path: `${pluginFolder}/package-lock.json`, name: 'version', times: 2 },
  { path: 'package.json', name: 'version', times: 1 },
  { path: 'package-lock.json', name: 'version', times: 2 },
];

export const manifestVersion = (dir, plugin) => read(dir, `${plugin.pluginFolder}/manifest.json`).Version;

/** @returns {string[]} one line for each file that does not say this version */
export function versionMismatches(dir, plugin, version) {
  return versionFiles(plugin).flatMap(({ path, name }) => {
    const found = read(dir, path)[name];
    return found === version ? [] : [`${path} says ${found}`];
  });
}

export function setVersion(dir, plugin, version) {
  for (const { path, name, times } of versionFiles(plugin)) {
    let left = times;
    const text = readFileSync(join(dir, path), 'utf8');
    const updated = text.replace(new RegExp(`"${name}":\\s*"[^"]*"`, 'g'), (match) => (left-- > 0 ? `"${name}": "${version}"` : match));
    writeFileSync(join(dir, path), updated);
  }
}
