import { describe, expect, it } from 'vitest';

import {
  formatFormAnswers,
  splitOnQuestionForms,
  parsePartialQuestionForm,
} from '../../src/artifacts/question-form';

const VALID_BODY = `{
  "questions": [
    { "id": "platform", "label": "Platform", "type": "radio",
      "options": ["Mobile", "Desktop", "Responsive"], "required": true }
  ]
}`;

describe('splitOnQuestionForms', () => {
  it('normalizes string and object question options', () => {
    const input = [
      '<question-form id="discovery" title="Quick brief">',
      '{',
      '  "questions": [',
      '    {',
      '      "id": "platform",',
      '      "label": "Primary surface",',
      '      "type": "radio",',
      '      "required": true,',
      '      "options": [',
      '        "Responsive",',
      '        { "label": "Mobile (iOS/Android)", "description": "Phone-first app prototype", "value": "mobile" },',
      '        { "label": "Desktop web", "description": "Browser-first prototype" },',
      '        { "description": "Missing label" }',
      '      ]',
      '    }',
      '  ]',
      '}',
      '</question-form>',
    ].join('\n');

    const segments = splitOnQuestionForms(input);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: 'form' });
    if (segments[0]?.kind !== 'form') throw new Error('expected parsed form segment');

    expect(segments[0].form.questions[0]?.options).toEqual([
      { label: 'Responsive', value: 'Responsive' },
      {
        label: 'Mobile (iOS/Android)',
        value: 'mobile',
        description: 'Phone-first app prototype',
      },
      {
        label: 'Desktop web',
        value: 'Desktop web',
        description: 'Browser-first prototype',
      },
    ]);
  });

  it('preserves stable option values when formatting object-option answers', () => {
    const text = formatFormAnswers(
      {
        id: 'discovery',
        title: 'Quick brief',
        questions: [
          {
            id: 'platform',
            label: 'Primary surface',
            type: 'radio',
            options: [
              { label: 'Mobile (iOS/Android)', value: 'mobile' },
              { label: 'Desktop web', value: 'Desktop web' },
            ],
          },
        ],
      },
      { platform: 'mobile' },
    );

    expect(text).toContain('- Primary surface: Mobile (iOS/Android) [value: mobile]');
  });

  it('parses the canonical <question-form> tag', () => {
    const out = splitOnQuestionForms(`prose\n<question-form id="d" title="T">${VALID_BODY}</question-form>\nmore`);
    expect(out.map((s) => s.kind)).toEqual(['text', 'form', 'text']);
    if (out[1]?.kind === 'form') {
      expect(out[1].form.id).toBe('d');
      expect(out[1].form.questions).toHaveLength(1);
    }
  });

  it('accepts <ask-question> as an alias for <question-form> (#1194)', () => {
    const out = splitOnQuestionForms(`<ask-question id="brief" title="Quick brief">${VALID_BODY}</ask-question>`);
    expect(out.map((s) => s.kind)).toEqual(['form']);
    if (out[0]?.kind === 'form') {
      expect(out[0].form.id).toBe('brief');
      expect(out[0].form.title).toBe('Quick brief');
      expect(out[0].form.questions[0]?.id).toBe('platform');
    }
  });

  it('handles mixed casing on the alias (e.g. <Ask-Question>)', () => {
    const out = splitOnQuestionForms(`<Ask-Question>${VALID_BODY}</Ask-Question>`);
    expect(out.map((s) => s.kind)).toEqual(['form']);
  });

  it('does not close one tag with the other tag name', () => {
    const out = splitOnQuestionForms(`<question-form>${VALID_BODY}</ask-question>`);
    expect(out.map((s) => s.kind)).toEqual(['text']);
  });

  it('keeps malformed JSON bodies as raw text', () => {
    const out = splitOnQuestionForms(`<ask-question>not json</ask-question>`);
    expect(out.map((s) => s.kind)).toEqual(['text']);
  });

  it('keeps unterminated tags as prose without swallowing trailing text', () => {
    const out = splitOnQuestionForms(`leading <ask-question>${VALID_BODY}`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'text' });
  });

  it('finds close tags without Unicode index desync (#1194)', () => {
    const out = splitOnQuestionForms(`prefix İ suffix<ask-question id="x">${VALID_BODY}</ask-question>`);
    expect(out.map((s) => s.kind)).toEqual(['text', 'form']);
    if (out[1]?.kind === 'form') {
      expect(out[1].form.id).toBe('x');
    }
  });
});

describe('parsePartialQuestionForm (true token-by-token streaming)', () => {
  it('surfaces a question before its object closes, then grows its options', () => {
    const midLabel = '<question-form id="discovery">{"questions":[{"id":"platform","label":"Platform"';
    expect(parsePartialQuestionForm(midLabel)?.questions.map((q) => q.label)).toEqual(['Platform']);

    const oneOption =
      '<question-form id="discovery">{"questions":[{"id":"platform","label":"Platform","type":"radio","options":["Mobile"';
    expect(parsePartialQuestionForm(oneOption)?.questions[0]?.options?.map((o) => o.label)).toEqual([
      'Mobile',
    ]);

    const twoOptions =
      '<question-form id="discovery">{"questions":[{"id":"platform","label":"Platform","type":"radio","options":["Mobile","Desktop"';
    expect(parsePartialQuestionForm(twoOptions)?.questions[0]?.options?.map((o) => o.label)).toEqual([
      'Mobile',
      'Desktop',
    ]);
  });

  it('holds back a trailing question until its label exists (no id placeholder flicker)', () => {
    const buf =
      '<question-form id="discovery">{"questions":[{"id":"a","label":"First","type":"text"},{"id":"b"';
    expect(parsePartialQuestionForm(buf)?.questions.map((q) => q.label)).toEqual(['First']);
  });

  it('reads title/id from the open tag before any question arrives', () => {
    const f = parsePartialQuestionForm('<question-form id="discovery" title="Quick brief">{"questions":[');
    expect(f?.id).toBe('discovery');
    expect(f?.title).toBe('Quick brief');
    expect(f?.questions).toEqual([]);
  });

  it('does not let a nested question id/description masquerade as form metadata', () => {
    // No form-level id on the tag or top-level body — only a question-level
    // id. The form id must stay the stable fallback, not adopt "platform"
    // (which would change the live panel's identity mid-stream).
    const f = parsePartialQuestionForm(
      '<question-form>{"questions":[{"id":"platform","label":"Platform","description":"nested"',
    );
    expect(f?.id).toBe('discovery');
    expect(f?.description).toBeUndefined();
    expect(f?.questions.map((q) => q.label)).toEqual(['Platform']);
  });

  it('keeps streaming through a closed ```json fence before the close tag arrives', () => {
    // Fenced body fully written, trailing ``` present, but </question-form>
    // not yet — the preview must stay populated, not drop to empty.
    const buf =
      '<question-form id="discovery">```json\n{"questions":[{"id":"a","label":"First","type":"text"}]}\n```';
    expect(parsePartialQuestionForm(buf)?.questions.map((q) => q.label)).toEqual(['First']);
  });

  it('keeps streaming while only a partial trailing fence has arrived', () => {
    const buf =
      '<question-form id="discovery">```json\n{"questions":[{"id":"a","label":"First","type":"text"}]}\n``';
    expect(parsePartialQuestionForm(buf)?.questions.map((q) => q.label)).toEqual(['First']);
  });

  it('does not strip backticks that are content of a label still being typed', () => {
    // The trailing ``` here is inside an open string value, not a closing
    // fence — it must survive into the preview, not be trimmed to "Use ".
    const buf = '<question-form id="discovery">{"questions":[{"id":"a","label":"Use ```';
    expect(parsePartialQuestionForm(buf)?.questions[0]?.label).toContain('```');
  });

  it('carries a custom submitLabel through the streaming preview', () => {
    const buf =
      '<question-form id="discovery">{"submitLabel":"Generate brief","questions":[{"id":"a","label":"First","type":"text"}';
    expect(parsePartialQuestionForm(buf)?.submitLabel).toBe('Generate brief');
  });

  it('keeps already-visible questions when a boolean value is split across deltas', () => {
    // `required` cut mid-`true` must not drop the question already shown.
    const buf = '<question-form id="discovery">{"questions":[{"id":"a","label":"Q","required":t';
    expect(parsePartialQuestionForm(buf)?.questions.map((q) => q.label)).toEqual(['Q']);
  });

  it('keeps a preview question id stable when label streams before its canonical id', () => {
    // label-first: id falls back to the index-pinned preview id.
    const labelFirst = parsePartialQuestionForm(
      '<question-form id="discovery">{"questions":[{"label":"Platform"',
    );
    // …then the canonical id arrives — the preview id must NOT change, or the
    // editable field remounts and orphans the user's in-progress answer.
    const idLater = parsePartialQuestionForm(
      '<question-form id="discovery">{"questions":[{"label":"Platform","id":"platform"',
    );
    expect(labelFirst?.questions[0]?.id).toBe('q1');
    expect(idLater?.questions[0]?.id).toBe('q1');
  });
});
