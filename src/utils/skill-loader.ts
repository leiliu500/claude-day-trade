import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx): src/utils/ → ../skills = src/skills/
// In prod (node dist/): dist/utils/ → ../skills = dist/skills/
const skillsDir = resolve(__dirname, '../skills');

export function loadSkill(name: string): string {
  return readFileSync(resolve(skillsDir, `${name}.md`), 'utf-8');
}

export function loadSkillTemplate(name: string, vars: Record<string, string>): string {
  let template = loadSkill(name);
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}
