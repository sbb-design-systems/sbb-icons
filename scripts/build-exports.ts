import { readFileSync, writeFileSync } from 'fs';

(() => {
  const fileContent = readFileSync(
    new URL('../icons/index.json', import.meta.url),
    'utf-8'
  );
  const icons: { version: string; icons: { name: string }[] } =
    JSON.parse(fileContent);

  const iconMap = icons.icons.reduce(
    (current, next) =>
      Object.assign(current, { [pascalCase(next.name)]: next.name }),
    {} as Record<string, string>
  );

  writeFileSync(
    new URL('../icons/index.cjs', import.meta.url),
    toCjs(),
    'utf-8'
  );
  writeFileSync(
    new URL('../icons/index.mjs', import.meta.url),
    toMjs(),
    'utf-8'
  );
  writeFileSync(
    new URL('../icons/index.d.ts', import.meta.url),
    toDTs(),
    'utf-8'
  );

  function pascalCase(str: string) {
    return str
      .replace(/\s*-\s*\w/g, (parts) => parts[parts.length - 1].toUpperCase())
      .replace(/^\w/, (s) => s.toUpperCase());
  }

  function toCjs() {
    const values = Object.entries(iconMap)
      .map(([key, value]) => `  ${key}: '${value}',`)
      .join('\n');
    return `module.exports = {\n  VERSION: '${icons.version}',\n${values}\n};\n`;
  }

  function toMjs() {
    const values = Object.entries(iconMap)
      .map(([key, value]) => `export const ${key} = '${value}';`)
      .join('\n');
    return `export const VERSION = '${icons.version}';\n${values}\n`;
  }

  function toDTs() {
    const values = Object.entries(iconMap)
      .map(([key, _value]) => `export const ${key}: string;`)
      .join('\n');
    return `export const VERSION: string;\n${values}\n`;
  }
})();
