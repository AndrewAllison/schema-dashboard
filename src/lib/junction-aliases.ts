/**
 * Persistent store for junction table alias mappings.
 * Saved to .junction-aliases.json at the project root.
 * This file can be committed to source control to share alias mappings across the team.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALIAS_FILE = join(process.cwd(), '.junction-aliases.json');

export interface JunctionAlias {
  dev:  string;
  prod: string;
  note?: string;
}

export function loadAliases(): JunctionAlias[] {
  try {
    if (existsSync(ALIAS_FILE)) {
      return JSON.parse(readFileSync(ALIAS_FILE, 'utf-8')) as JunctionAlias[];
    }
  } catch { /* ignore parse errors */ }
  return [];
}

export function saveAliases(aliases: JunctionAlias[]): void {
  writeFileSync(ALIAS_FILE, JSON.stringify(aliases, null, 2), 'utf-8');
}

export function addAlias(dev: string, prod: string, note?: string): JunctionAlias[] {
  const aliases = loadAliases();
  const exists = aliases.some(a => a.dev === dev && a.prod === prod);
  if (!exists) aliases.push({ dev, prod, ...(note ? { note } : {}) });
  saveAliases(aliases);
  return aliases;
}

export function removeAlias(dev: string, prod: string): JunctionAlias[] {
  const aliases = loadAliases().filter(a => !(a.dev === dev && a.prod === prod));
  saveAliases(aliases);
  return aliases;
}
