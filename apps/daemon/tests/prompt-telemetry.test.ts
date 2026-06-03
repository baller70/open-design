import { describe, expect, it } from 'vitest';

import {
  PROMPT_STACK_PATH_MARKER,
  buildPromptStackTelemetry,
  promptStackWithoutContent,
  redactLocalPaths,
} from '../src/prompt-telemetry.js';

describe('prompt telemetry builder', () => {
  it('redacts local paths and secrets before hashing or content capture', () => {
    const telemetry = buildPromptStackTelemetry({
      composedPrompt:
        'Use /Users/alice/work/repo/index.html with sk-test-1234567890123456789012.',
      sections: [
        {
          kind: 'daemonSystemPrompt',
          content:
            'Read /Users/alice/work/repo/index.html and token sk-test-1234567890123456789012.',
        },
      ],
    });

    const section = telemetry.sections[0]!;
    expect(section.redactedContent).toContain(PROMPT_STACK_PATH_MARKER);
    expect(section.redactedContent).toContain('[REDACTED:sk_key]');
    expect(section.redactedContent).not.toContain('/Users/alice');
    expect(section.redactedContent).not.toContain('sk-test-');
    expect(section.fingerprint).toMatch(/^sha256:/);
    expect(telemetry.promptFingerprint).toMatch(/^sha256:/);
  });

  it('normalizes different local paths to the same prompt fingerprint', () => {
    const first = buildPromptStackTelemetry({
      composedPrompt: 'Open /Users/alice/project/src/App.tsx',
      sections: [{ kind: 'userRequest', content: 'Open /Users/alice/project/src/App.tsx' }],
    });
    const second = buildPromptStackTelemetry({
      composedPrompt: 'Open /Users/bob/other/src/App.tsx',
      sections: [{ kind: 'userRequest', content: 'Open /Users/bob/other/src/App.tsx' }],
    });

    expect(first.promptFingerprint).toBe(second.promptFingerprint);
    expect(first.sections[0]!.fingerprint).toBe(second.sections[0]!.fingerprint);
  });

  it('strips runtime tool token-bearing lines before capture', () => {
    const telemetry = buildPromptStackTelemetry({
      composedPrompt: 'tools',
      sections: [
        {
          kind: 'runtimeToolPrompt',
          content: [
            '## Runtime tool environment',
            '- `OD_TOOL_TOKEN` is available in your environment for this run.',
            '- Daemon URL: `http://127.0.0.1:1234`.',
          ].join('\n'),
        },
      ],
    });

    expect(telemetry.sections[0]!.redactedContent).not.toContain('OD_TOOL_TOKEN');
    expect(telemetry.sections[0]!.redactedContent).toContain('Daemon URL');
  });

  it('keeps metadata-only sections free of raw paths and attachment bodies', () => {
    const telemetry = buildPromptStackTelemetry({
      composedPrompt: 'attached',
      sections: [
        {
          kind: 'commentAttachments',
          content:
            'file: /Users/alice/project/index.html\ncomment: make the hero blue\nscreenshot: /tmp/mark.png',
          metadata: [
            {
              filePath: '/Users/alice/project/index.html',
              screenshotPath: '/tmp/mark.png',
              selectionKind: 'visual',
              comment: 'make the hero blue',
            },
          ],
        },
      ],
    });

    const section = telemetry.sections[0]!;
    expect(section.contentMode).toBe('metadata-only');
    expect(section.redactedContent).toBeUndefined();
    expect(section.metadata).toEqual({
      count: 1,
      extensions: ['html'],
      knownSizeCount: 0,
      selectionKinds: { visual: 1 },
      sizeBuckets: {},
    });
    expect(JSON.stringify(section)).not.toContain('/Users/alice');
    expect(JSON.stringify(section)).not.toContain('make the hero blue');
  });

  it('applies per-section limits and total budget in diagnostic priority order', () => {
    const huge = 'x'.repeat(120 * 1024);
    const telemetry = buildPromptStackTelemetry({
      composedPrompt: huge,
      sections: [
        { kind: 'userRequest', content: huge },
        { kind: 'formOverride', content: huge },
        { kind: 'daemonSystemPrompt', content: huge },
        { kind: 'runtimeToolPrompt', content: huge },
        { kind: 'clientSystemPrompt', content: huge },
        { kind: 'skillPrompt', content: huge },
        { kind: 'designSystemPrompt', content: huge },
        { kind: 'pluginStagePrompt', content: huge },
        { kind: 'researchCommandContract', content: huge },
        { kind: 'runContextPrompt', content: huge },
        { kind: 'echoGuard', content: huge },
      ],
    });

    expect(telemetry.redactedContentBytes).toBe(96 * 1024);
    expect(telemetry.sections.find((s) => s.kind === 'formOverride')?.redactedContent)
      .toHaveLength(16 * 1024);
    expect(
      telemetry.sections.find((s) => s.kind === 'daemonSystemPrompt')?.redactedContent,
    ).toHaveLength(32 * 1024);
    expect(telemetry.sections.find((s) => s.kind === 'clientSystemPrompt')?.redactedContent)
      .toHaveLength(16 * 1024);
    expect(telemetry.sections.find((s) => s.kind === 'skillPrompt')?.redactedContent)
      .toHaveLength(16 * 1024);
    const userRequest = telemetry.sections.find((s) => s.kind === 'userRequest')!;
    expect(userRequest.redactedContent).toBeUndefined();
    expect(userRequest.truncationReason).toBe('total_budget_exceeded');
  });

  it('removes redactedContent when content consent is unavailable', () => {
    const telemetry = buildPromptStackTelemetry({
      composedPrompt: 'hello',
      sections: [{ kind: 'userRequest', content: 'hello' }],
    });

    const metadataOnly = promptStackWithoutContent(telemetry);
    expect(metadataOnly.redactedContentBytes).toBe(0);
    expect(metadataOnly.sections[0]!.redactedContent).toBeUndefined();
    expect(metadataOnly.sections[0]!.fingerprint).toBe(telemetry.sections[0]!.fingerprint);
  });

  it('redacts Windows local paths', () => {
    expect(redactLocalPaths('Open C:\\Users\\alice\\repo\\index.html')).toBe(
      `Open ${PROMPT_STACK_PATH_MARKER}`,
    );
  });
});
