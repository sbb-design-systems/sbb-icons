import * as Figma from 'figma-js';
import { readFileSync, writeFileSync } from 'fs';
import { Octokit } from 'octokit';
import { optimize } from 'svgo';

const iconsFileId = process.env.FIGMA_FILE_ID!;
const iconBatchSize = 200;
const knownSizes = ['small', 'medium', 'large'];
const figmaToken = process.env.FIGMA_TOKEN!;
const githubToken = process.env.GITHUB_TOKEN!;
const repositorySlug = process.env.GITHUB_REPOSITORY!;

interface Description {
  color?: boolean;
  scalable?: boolean;
  keywords?: string;
}

(async () => {
  const errors: Array<{ message: string; severity: 'warn' | 'error' }> = [];
  const client = Figma.Client({ personalAccessToken: figmaToken });
  const octokit = new Octokit({ auth: githubToken });
  let components: Record<string, Figma.ComponentMetadata> = {};

  class SvgIcon {
    url?: string;

    constructor(
      readonly fullPath: Figma.Node[],
      readonly path = fullPath.slice(0, fullPath.length - 1),
      readonly pathAsString = fullPath.map((n) => n.name).join(' => '),
      readonly component = fullPath.at(-1) as Figma.Component,
      readonly id = component.id,
      readonly fileName = createIconFileName(fullPath, component, pathAsString),
      readonly description = tryParseJSON<Description>(
        components[id]?.description,
        id,
        pathAsString
      ),
      readonly keywords = [
        ...(description.keywords?.split(/[, ]+/) ?? []),
        ...fullPath.map((n) => n.name),
      ]
    ) {}

    valid() {
      return !!(this.fileName && this.url);
    }
  }

  try {
    await extractIcons();
  } catch (e) {
    console.log(e);
    const [owner, repo] = repositorySlug.split('/');
    const assignees = findAssignees();
    await octokit.rest.issues.create({
      owner,
      repo,
      title: `Icon Release Failure`,
      assignees,
      body: `Icon extraction failed due to: ${e}\n\n${errors
        .map((e) => `${e.severity} ${e.message}`)
        .join('\n')}`,
    });
    process.exit(1);
  }

  async function extractIcons() {
    const file = await client.file(iconsFileId);
    if (file.status >= 400) {
      throw new Error(`File request failed: ${file.statusText}`);
    }
    console.log(`Loaded file from figma`);
    components = file.data.components;
    const iconComponents = traverseChildren(file.data.document);
    console.log(`Found ${iconComponents.length} icons`);
    const iconList = await batchIconRequests(iconComponents);
    const invalidIcons = iconList.filter((i) => !i.valid());
    if (invalidIcons.length) {
      console.log(
        `Found ${invalidIcons.length} invalid icons:\n${invalidIcons
          .map((i) => ` - ${i.pathAsString}`)
          .join('\n')}`
      );
    }
    const validIcons = iconList.filter((i) => i.valid());

    console.log('Generating index.json');
    const packageJson = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf-8'
    );
    const data = {
      version: JSON.parse(packageJson).version,
      icons: validIcons.map((i) => ({
        name: i.fileName.replace(/.svg$/, ''),
        color: !!i.description.color,
        scalable: i.description.scalable,
        tags: i.keywords,
      })),
    };
    writeFileSync(
      new URL('../icons/index.json', import.meta.url),
      JSON.stringify(data, null, 2),
      'utf-8'
    );

    console.log('Starting svg download');
    let index = 0;
    for (const icon of validIcons) {
      const response = await fetch(icon.url!);
      if (response.status !== 200) {
        errors.push({
          message: `Failed to download icon for ${icon.fileName}`,
          severity: 'error',
        });
      } else {
        const content = await response.text();
        const minifiedContent = optimize(content, {
          plugins: [
            {
              name: 'preset-default',
              params: {
                overrides: {
                  removeViewBox: false,
                },
              },
            },
          ],
        });
        if (minifiedContent.error !== undefined) {
          errors.push({
            message: `Failed to minify icon ${icon.fileName} due to ${minifiedContent.error}`,
            severity: 'warn',
          });
        } else {
          let svg = minifiedContent.data;
          if (!icon.description.color) {
            svg = svg.replace('<svg ', `<svg class="color-immutable" `);
          }
          writeFileSync(
            new URL(`../icons/${icon.fileName}`, import.meta.url),
            svg,
            'utf-8'
          );
        }
      }
      index++;
      if (index % 50 === 0) {
        console.log(`Finished ${index} svg downloads`);
      }
    }

    console.log('Finished all svg downloads');
    if (errors.length) {
      errors.forEach((e) => console.log(`${e.severity} ${e.message}`));
      throw new Error(`Finished with ${errors.length} errors`);
    }
    console.log('Successfully completed');
  }

  function traverseChildren(
    node: Figma.Node,
    path: Figma.Node[] = []
  ): SvgIcon[] {
    if (!('children' in node)) {
      return [];
    }

    return node.children
      .filter((c) => !c.name.startsWith('_'))
      .map((child) => ({ child, newPath: [...path, child] }))
      .map(({ child, newPath }) =>
        child.type === 'COMPONENT'
          ? [new SvgIcon(newPath)]
          : traverseChildren(child, newPath)
      )
      .reduce((previous, current) => previous.concat(current));
  }

  async function batchIconRequests(
    icons: SvgIcon[],
    iconMap: Map<string, SvgIcon> = new Map()
  ): Promise<SvgIcon[]> {
    console.log(
      `Starting icon url batch request for ${iconMap.size} to ${
        iconMap.size + iconBatchSize
      }`
    );
    const requestBatch = icons.slice(0, iconBatchSize);
    for (const icon of requestBatch) {
      if (iconMap.has(icon.component.id)) {
        errors.push({
          message: `Duplicate icon id ${icon.id} (${icon.fileName})`,
          severity: 'warn',
        });
      }
      iconMap.set(icon.component.id, icon);
    }

    const response = await client.fileImages(iconsFileId, {
      ids: requestBatch.map((i) => i.component.id),
      format: 'svg',
    });
    if (response.status >= 400 || response.data.err) {
      throw new Error(
        `File request failed: ${response.statusText} ${response.data.err}`
      );
    }

    for (const [id, url] of Object.entries(response.data.images)) {
      const icon = iconMap.get(id);
      if (!icon) {
        errors.push({
          message: `Received response for unknown icon: ${id}`,
          severity: 'warn',
        });
      } else {
        icon.url = url;
      }
    }

    if (icons.length > iconBatchSize) {
      return await batchIconRequests(icons.slice(iconBatchSize), iconMap);
    }

    return Array.from(iconMap.values());
  }

  function createIconFileName(
    path: Figma.Node[],
    component: Figma.Component,
    pathAsString: string
  ) {
    const root = path[0];
    if (root.name === 'timetable-icons') {
      return `${component.name}.svg`;
    }

    const parent = path.at(-2)!;
    const parts = component.name.split('=');
    if (parts.length !== 2 || parts[0] !== 'Size') {
      if (knownSizes.includes(parts[1])) {
        errors.push({
          message: `Expected name Size=size, but got ${component.name} in ${pathAsString}`,
          severity: 'warn',
        });
      } else {
        errors.push({
          message: `Expected name Size=size, but got ${component.name} in ${pathAsString}`,
          severity: 'error',
        });
        return '';
      }
    }

    return `${parent.name}-${parts[1]}.svg`;
  }

  function tryParseJSON<T>(
    content: string | undefined,
    id: string,
    pathAsString: string
  ): Partial<T> {
    if (!content) {
      errors.push({
        message: `No data for ${id} in ${pathAsString}`,
        severity: 'warn',
      });
      return {};
    }

    try {
      return JSON.parse(content);
    } catch (e) {
      errors.push({
        message: `Failed to parse ${id} in ${pathAsString}\n${content}`,
        severity: 'warn',
      });
      return {};
    }
  }

  // Read the assignes from the CODEOWNERS file. Only use global (*) code owners.
  function findAssignees(): string[] {
    const codeOwners = readFileSync(
      new URL('../.github/CODEOWNERS', import.meta.url),
      'utf-8'
    );
    const codeOwnerList =
      codeOwners
        .split('\n')
        .find((l) => l.trim().startsWith('*'))
        ?.trim()
        .substring(1)
        .split(/[ @]+/)
        .filter((c) => !!c) ?? [];
    if (!codeOwnerList.length) {
      throw new Error(`Missing global code owners in CODEOWNERS file`);
    }

    return codeOwnerList;
  }
})();
