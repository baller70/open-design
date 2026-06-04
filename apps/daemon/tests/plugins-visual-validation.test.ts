import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  runVisualValidation,
  similarityToCritiqueScore,
} from '../src/plugins/atoms/visual-validation.js';

describe('visual validation atom runner', () => {
  it('skips cleanly when no reference images are present', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-skip-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async ({ outputPath }) => {
          await writeFile(outputPath, PNG.sync.write(createFilledPng(320, 240, [255, 255, 255, 255])));
        },
      });
      expect(result.report.status).toBe('skipped');
      expect(result.signals).toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('compares rendered output against reference screenshots and writes a report', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-compare-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(
        path.join(cwd, 'reference-home.png'),
        PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])),
      );
      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async ({ outputPath }) => {
          const png = createFilledPng(200, 120, [255, 255, 255, 255]);
          paintRect(png, { x: 40, y: 25, width: 60, height: 30 }, [255, 0, 0, 255]);
          await writeFile(outputPath, PNG.sync.write(png));
        },
      });

      expect(result.report.status).toBe('ok');
      expect(result.report.comparison?.similarity).toBeLessThan(95);
      expect(result.report.comparison?.diffPixels).toBeGreaterThan(0);
      expect(result.report.comparison?.suggestions.length).toBeGreaterThan(0);
      expect(result.signals['preview.ok']).toBe(true);
      expect(result.signals['critique.score']).toBe(3);

      const reportPath = path.join(cwd, 'critique', 'visual-validation', 'report.json');
      const saved = JSON.parse(await readFile(reportPath, 'utf8')) as { comparison?: { diffPixels?: number } };
      expect(saved.comparison?.diffPixels).toBe(result.report.comparison?.diffPixels);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when capture throws', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-fail-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(
        path.join(cwd, 'reference-home.png'),
        PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])),
      );
      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async () => {
          throw new Error('playwright launch failed');
        },
      });

      expect(result.report.status).toBe('failed');
      expect(result.report.message).toContain('playwright launch failed');
      expect(result.signals['preview.ok']).toBe(false);
      expect(result.signals['critique.score']).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips cleanly when the Playwright browser runtime is unavailable', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-no-browser-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(
        path.join(cwd, 'reference-home.png'),
        PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])),
      );
      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async () => {
          throw new Error(
            "browserType.launch: Executable doesn't exist at /tmp/ms-playwright/chromium\nPlease run the following command to download new browsers: npx playwright install",
          );
        },
      });

      expect(result.report.status).toBe('skipped');
      expect(result.report.message).toContain('Playwright browser runtime unavailable');
      expect(result.signals).toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips ignored dependency trees before recursing for references', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-ignore-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await mkdir(path.join(cwd, 'references'), { recursive: true });
      await writeFile(
        path.join(cwd, 'references', 'reference-home.png'),
        PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])),
      );
      await mkdir(path.join(cwd, 'node_modules', 'huge-package', 'assets'), { recursive: true });
      await chmod(path.join(cwd, 'node_modules'), 0o000);

      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async ({ outputPath }) => {
          await writeFile(outputPath, PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])));
        },
      });

      expect(result.report.status).toBe('ok');
    } finally {
      await chmod(path.join(cwd, 'node_modules'), 0o755).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('only auto-discovers PNG reference screenshots', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'od-visual-png-only-'));
    try {
      await writeFile(path.join(cwd, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(path.join(cwd, 'reference-home.jpg'), 'not-a-png', 'utf8');

      const result = await runVisualValidation({
        cwd,
        captureScreenshot: async ({ outputPath }) => {
          await writeFile(outputPath, PNG.sync.write(createFilledPng(200, 120, [255, 255, 255, 255])));
        },
      });

      expect(result.report.status).toBe('skipped');
      expect(result.report.message).toContain('no reference screenshot found');
      expect(result.signals).toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('maps similarity bands to critique scores conservatively', () => {
    expect(similarityToCritiqueScore(99)).toBe(5);
    expect(similarityToCritiqueScore(96)).toBe(4);
    expect(similarityToCritiqueScore(90)).toBe(3);
    expect(similarityToCritiqueScore(80)).toBe(2);
    expect(similarityToCritiqueScore(60)).toBe(1);
  });
});

function createFilledPng(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return png;
}

function paintRect(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
  rgba: readonly [number, number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * png.width + x) << 2;
      png.data[index] = rgba[0];
      png.data[index + 1] = rgba[1];
      png.data[index + 2] = rgba[2];
      png.data[index + 3] = rgba[3];
    }
  }
}
